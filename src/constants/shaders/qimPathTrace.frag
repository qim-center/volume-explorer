precision highp float;
precision highp int;
precision highp sampler3D;

// Sampling
uniform sampler2D previous;
uniform uint sampleSeed;
uniform float sampleWeight;

// Volume
uniform sampler3D volume;
uniform vec3 volumeMin;
uniform vec3 volumeMax;
uniform vec3 volumeInvSize;
uniform float majorant;

// Lut
uniform float intensityMin;
uniform float intensityInvRange;
uniform sampler2D lut;
uniform float alphaToExtinctionFactor;

// Camera
uniform uvec2 resolution;
uniform vec2 invResolution;
uniform mat4 invViewProjection;


// Math helpers
const float pi = 3.14159265359;

float max3(vec3 v) {
  return max(v.x, max(v.y, v.z));
}

float min3(vec3 v) {
  return min(v.x, min(v.y, v.z));
}

// PRNG xorshift seed generator by NVIDIA
uint tea(uint v0, uint v1)
{
    const uint N = 16u; // User specified number of iterations
    uint s0 = 0u;
    for(uint n = 0u; n < N; n++) {
        s0 += 0x9e3779b9u;
        v0 += ((v1<<4u)+0xa341316cu)^(v1+s0)^((v1>>5u)+0xc8013ea4u);
        v1 += ((v0<<4u)+0xad90777du)^(v0+s0)^((v0>>5u)+0x7e95761eu);
    }

    return v0;
}

// Generate random unsigned int in [0, 2^31-1)
void mcg31(inout uint randState) {
  const uint LCG_A = 1977654935u; // Multiplier from Hui-Ching Tang [EJOR 2007]
  randState = (LCG_A * randState) & 0x7FFFFFFEu;
}

// Generate random float uniformly distributed in [0, 1)
// pdf is implicitly 1
float rnd(inout uint randState) {
  mcg31(randState);
  return float(randState) / float(0x80000000u);
}

// Generate random float exponentially distributed according to rate
// pdf is implicitly rate * exp(-rate * x)
float sampleExponential(float rate, inout uint randState) {
    return -log(1.0 - rnd(randState)) / rate;
}

// Generate uniformly distributed vector in S^2
// pdf is implicitly 1 / (4 * pi)
vec3 sampleSphere(inout uint randState) {
    float phi = 2.0 * pi * rnd(randState);
    float cosTheta = 2.0 * rnd(randState) - 1.0;
    float sinTheta = sqrt(max(1.0 - cosTheta * cosTheta, 0.0));

    return vec3(
        sinTheta * cos(phi),
        sinTheta * sin(phi),
        cosTheta
    );
}

// Get a ray that correspond to the given screen space (a.k.a pixel) coordinates.
// Current implementation uses the inverse view projection matrix to ensure it works across different camera models.
// This requires two 4x4 matvecs- and two divisions, which could be optimized by assuming a perspective camera.
void screenSpaceToWorldRay(vec2 screenSpacePosition, out vec3 rayOrigin, out vec3 rayDirection) {
  vec2 clipSpaceXY = 2.0 * (screenSpacePosition * invResolution) - 1.0;

  vec4 homNear = invViewProjection * vec4(clipSpaceXY, 0.0, 1.0);
  vec4 homFar = invViewProjection * vec4(clipSpaceXY, 1.0, 1.0);

  vec3 worldNear = homNear.xyz * (1.0 / homNear.w);
  vec3 worldFar = homFar.xyz * (1.0 / homFar.w);

  rayOrigin = worldNear;
  rayDirection = normalize(worldFar - worldNear);
}

bool intersectAabb(vec3 rayOrigin, vec3 rayDirection, float tMin, float tMax, vec3 aabbMin, vec3 aabbMax, out float t) {
  vec3 rayInvDirection = 1.0 / rayDirection;

  // the t for which ray hits min plane for each axis:
  // rayOrigin + t1 * rayDirection = aabbMin <=>
  vec3 t1 = (aabbMin - rayOrigin) * rayInvDirection;

  // the t for which ray hit max plane for each axis
  // rayOrigin + t2 * rayDirection = aabbMax <=>
  vec3 t2 = (aabbMax - rayOrigin) * rayInvDirection;

  // t for which ray enters slab for each axis
  vec3 tEnter = min(t1, t2);
  // t for which ray exits slab for each axis
  vec3 tExit = max(t1, t2);
 
  // the interval for which we are inside the AABB
  float tLastEnter = max3(tEnter);
  float tFirstExit = min3(tExit);

  // check if line misses box entirely
  if (tLastEnter > tFirstExit) {
    return false;
  }

  // check if enter t is in the interval
  if (tMin < tLastEnter && tLastEnter < tMax) {
    t = tLastEnter;
    return true;
  }

  // check if exit t is in the interval
  if (tMin < tFirstExit && tFirstExit < tMax) {
    t = tFirstExit;
    return true;
  }

  return false;
}

bool inAabb(vec3 position, vec3 aabbMin, vec3 aabbMax) {
  return (aabbMin.x <= position.x && position.x <= aabbMax.x)
    && (aabbMin.y <= position.y && position.y <= aabbMax.y)
    && (aabbMin.z <= position.z && position.z <= aabbMax.z);
}

vec3 worldToVolume(vec3 worldPosition) {
  return (worldPosition - volumeMin) * volumeInvSize;
} 

// Map an intensity to an albedo and an extinction coefficient
void albedoExtinction(float intensity, out vec3 albedo, out float extinction) {
  float u = (intensity - intensityMin) * intensityInvRange;
  vec4 lutValue = texture(lut, vec2(u, 0.5));

  albedo = lutValue.rgb;
  extinction = alphaToExtinctionFactor * lutValue.a;
}

// Samples a direction towards an emitter from position and also returns emitted radiance from that emitter towards position
vec3 sampleEmitterDirection(vec3 position, out float pdf, out vec3 radiance, inout uint randState)  {
  radiance = vec3(12.0);
  pdf = 1.0;

  return normalize(vec3(1.0, -1.0, 1.0));
}


// Compute an estimate of the transmittance from rayOrigin all the way out of the volume.
// Current implementation uses delta tracking, although ratio tracking may be better for some volumes.
float estimateTransmittance(vec3 rayOrigin, vec3 rayDirection, uint randState) {
  for(uint i = 0u; i < 128u; i++) {
    float t = sampleExponential(majorant, randState);
    rayOrigin += t * rayDirection;

    if (!inAabb(rayOrigin, volumeMin, volumeMax)) {
      return 1.0;
    }

    float intensity = texture(volume, worldToVolume(rayOrigin)).r;
    vec3 _albedo;
    float extinction;
    albedoExtinction(intensity, _albedo, extinction);

    if (rnd(randState) < extinction / majorant) {
      return 0.0;
    }
  }
}

// Samples wi from a distribution approximating Li(position, wi) and also returns the value of Li(position, wi)
vec3 sampleDirectIncidentRadiance(vec3 position, out float pdf, out vec3 radiance, inout uint randState) {
  vec3 direction = sampleEmitterDirection(position, pdf, radiance, randState);

  float transmittance = estimateTransmittance(position, direction, randState);

  radiance *= transmittance;

  return direction;
}

// Evaluates the phase function of the medium, i.e. p(wi, wo)
float evaluatePhaseFunction(vec3 wi, vec3 wo) {
  return 1.0 / (4.0 * pi);
}

// Samples wo from the phase function p(wi, wo)
// Also computes the value of the phase function
vec3 samplePhaseFunction(vec3 wo, out float pdf, out float phase, inout uint randState) {
  pdf = 1.0 / (4.0 * pi);
  return sampleSphere(randState);
}

// Computes an estimate of incident radiance Li(rayOrigin, rayDirection) and
// simultaneously estimates the transmittance from rayOrigin all the way out of the medium in rayDirection 
vec3 estimateRadianceAndTransmittance(vec3 rayOrigin, vec3 rayDirection, out float transmittance, inout uint randState) {
  float t;
  bool hit = intersectAabb(rayOrigin, rayDirection, 0.0, 1e9, volumeMin, volumeMax, t);
  if (!hit) {
    // The ray fully misses the medium
    transmittance = 1.0;
    return vec3(0.0);
  }
  rayOrigin += t * rayDirection;

  vec3 radiance = vec3(0.0);
  vec3 throughput = vec3(1.0);
  bool interacted = false; // whether the primary ray interacted with the medium or not

  // trace path
  for(uint i = 0u; i < 128u; i++) {
    t = sampleExponential(majorant, randState);
    rayOrigin += t * rayDirection;

    if (!inAabb(rayOrigin, volumeMin, volumeMax)) {
      break;
    }

    float intensity = texture(volume, worldToVolume(rayOrigin)).r;
    vec3 albedo;
    float extinction;
    albedoExtinction(intensity, albedo, extinction);

    // Skip if null interaction
    if (rnd(randState) < 1.0 - extinction / majorant) continue;

    interacted = true;

    float maxAlbedo = max3(albedo);

    if (rnd(randState) < maxAlbedo) {

      throughput *= albedo * (1.0 / maxAlbedo);

      // Scattering interaction
      vec3 wo = -rayDirection;
      {
        // Next event estimation
        float pdf;
        vec3 incidentRadiance;

        vec3 wi = sampleDirectIncidentRadiance(rayOrigin, pdf, incidentRadiance, randState);
        float phase = evaluatePhaseFunction(wi, wo);

        radiance += throughput * phase * incidentRadiance * (1.0 / pdf);
      }

      // Scatter
      float pdf;
      float phase;
      rayDirection = samplePhaseFunction(-rayDirection, pdf, phase, randState);
      throughput *= phase / pdf;

    } else {
      // Absorption interaction simply ends the path
      break;
    }

  }

  transmittance = interacted ? 0.0 : 1.0;
  return radiance;
}

void main()
{
  uvec2 fragIndices = uvec2(gl_FragCoord.xy);
  uint randState = tea(fragIndices.x + fragIndices.y * resolution.x, sampleSeed);

  vec3 rayOrigin;
  vec3 rayDirection;
  screenSpaceToWorldRay(gl_FragCoord.xy, rayOrigin, rayDirection);
  
  float transmittance;
  vec3 radiance = estimateRadianceAndTransmittance(rayOrigin, rayDirection, transmittance, randState);
   
  float opacity = 1.0 - transmittance;

  vec4 previousEstimate = texelFetch(previous, ivec2(fragIndices), 0);
  vec4 newEstimate = mix(previousEstimate, vec4(radiance, opacity), sampleWeight);

  gl_FragColor = newEstimate;
}
