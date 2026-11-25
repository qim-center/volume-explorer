precision highp float;
precision highp int;
precision highp sampler3D;

// sampling
uniform sampler2D previous;
uniform uint sampleSeed;
uniform float sampleWeight;

// volume
uniform sampler3D volume;
uniform vec3 volumeMin;
uniform vec3 volumeMax;
uniform vec3 volumeInvSize;
uniform float volumeMajorant;

// camera
uniform uvec2 resolution;
uniform vec2 invResolution;
uniform mat4 invViewProjection;

const float tMin = 1e-3;
const float tMax = 1e9;

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

// Generate random float in [0, 1)
float rnd(inout uint randState) {
    mcg31(randState);
    return float(randState) / float(0x80000000u);
}

/*
  Get a ray that correspond to the given screen space (a.k.a pixel) coordinates.
  Current implementation uses the inverse view projection matrix to ensure it works across different camera models.
  This requires two 4x4 matvecs and two divisions, which could be optimized by assuming a perspective camera.
*/
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

vec3 worldToVolume(vec3 worldPosition) {
  return (worldPosition - volumeMin) * volumeInvSize;
} 

vec3 estimateRadianceAndTransmittance(vec3 rayOrigin, vec3 rayDirection, out float transmittance, inout uint randState) {
  vec3 radiance = vec3(0.0);
  transmittance = 1.0;

  float t;
  bool hit = intersectAabb(rayOrigin, rayDirection, tMin, tMax, volumeMin, volumeMax, t);

  if (!hit) {
    return radiance;
  }

  rayOrigin += t * rayDirection;

  for(uint i = 0u; i < 256u; i++) {
    t = -log(rnd(randState)) / volumeMajorant;
    float s;
    hit = intersectAabb(rayOrigin, rayDirection, tMin, t, volumeMin, volumeMax, s);

    if (hit) {
      return radiance;
    }

    vec3 position = rayOrigin + t * rayDirection;
    float intensity = texture(volume, worldToVolume(position)).r;
    
    if (rnd(randState) < intensity / volumeMajorant) {
      transmittance = 0.0;
      return radiance;
    }

    rayOrigin = position;
  }
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
