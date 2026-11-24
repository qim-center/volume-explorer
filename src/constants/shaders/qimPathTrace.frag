precision highp float;
precision highp int;
precision highp sampler3D;

// sampling
uniform sampler2D previous;
uniform float sampleWeight;

// volume
uniform sampler3D volume;
uniform vec3 volumeMin;
uniform vec3 volumeMax;
uniform vec3 volumeInvSize;

// camera
uniform vec2 invResolution;
uniform mat4 invViewProjection;

float max3(vec3 v) {
  return max(v.x, max(v.y, v.z));
}

float min3(vec3 v) {
  return min(v.x, min(v.y, v.z));
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

bool intersectAabb(vec3 rayOrigin, vec3 rayDirection, vec3 aabbMin, vec3 aabbMax, out float t) {
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
 
  // the last enter t across axes
  float tLastEnter = max3(tEnter);
  // the first exit t across axes
  float tEarliestExit = min3(tExit);

  // clip enter t to ignore intersections behind
  tLastEnter = max(0.0, tLastEnter);

  t = tLastEnter;
  return tLastEnter < tEarliestExit;
}

vec3 worldToVolume(vec3 worldPosition) {
  return (worldPosition - volumeMin) * volumeInvSize;
} 

void main()
{
  vec3 rayOrigin;
  vec3 rayDirection;
  screenSpaceToWorldRay(gl_FragCoord.xy, rayOrigin, rayDirection);

  float t;
  bool hit = intersectAabb(rayOrigin, rayDirection, volumeMin, volumeMax, t);

  vec3 hitPosition = rayOrigin + t * rayDirection;
  
  if (hit) {
    float intensity = texture(volume, worldToVolume(hitPosition)).r;
    pc_fragColor = vec4(intensity, 0.0, 0.0, 1.0);
  } else {
    pc_fragColor = vec4(0.0, 0.0, 0.0, 1.0);
  }
}
