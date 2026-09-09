import { GS_DEPTH_GLSL } from '../depth/gsDepthShader'
// Native linear emission integration; frozen post-integration legacy clipping.
export const FIRE_VOLUME_V2_FRAGMENT = `
  precision highp float;
  ${GS_DEPTH_GLSL}
  varying vec3 vWorldPosition;
  uniform vec3 view_position;
  uniform vec3 uViewerLower;
  uniform vec3 uViewerUpper;
  uniform vec3 uDisplayOffset;
  uniform vec3 uSourceLower;
  uniform vec3 uSourceExtent;
  uniform sampler2D uVolume0;
  uniform sampler2D uVolume1;
  uniform vec3 uGridDimensions;
  uniform float uFrameAlpha;
  uniform sampler2D uSmoke0;
  uniform sampler2D uSmoke1;
  uniform vec3 uEmissionScale;
  uniform float uSteps;
  uniform float uDepthEnabled;
  uniform sampler2D uProxyDepth;
  uniform vec2 uViewport;
  uniform float uFarClip;
  uniform mat4 matrix_view;
  uniform float uSmokeStrength;

  // Store the cropped XYZ volume as a 2D atlas with Z slices stacked down Y.
  // This avoids unreliable sampler3D/RG8 behavior in Windows WebView while
  // preserving filtered XY sampling and explicitly interpolating adjacent Z.
  vec4 sampleAtlas(sampler2D atlas, vec3 uv) {
    vec3 grid = max(uGridDimensions, vec3(1.0));
    vec3 voxel = clamp(uv, 0.0, 1.0) * max(grid - 1.0, vec3(0.0));
    float z0 = floor(voxel.z);
    float z1 = min(z0 + 1.0, grid.z - 1.0);
    float zBlend = voxel.z - z0;
    float atlasHeight = grid.y * grid.z;
    vec2 uv0 = vec2((voxel.x + 0.5) / grid.x,
                    (z0 * grid.y + voxel.y + 0.5) / atlasHeight);
    vec2 uv1 = vec2((voxel.x + 0.5) / grid.x,
                    (z1 * grid.y + voxel.y + 0.5) / atlasHeight);
    return mix(texture2D(atlas, uv0), texture2D(atlas, uv1), zBlend);
  }

  vec2 intersectBox(vec3 origin, vec3 direction) {
    vec3 safeDirection = direction;
    safeDirection.x = abs(direction.x) < 1.0e-6 ? 1.0e-6 : direction.x;
    safeDirection.y = abs(direction.y) < 1.0e-6 ? 1.0e-6 : direction.y;
    safeDirection.z = abs(direction.z) < 1.0e-6 ? 1.0e-6 : direction.z;
    vec3 inverseDirection = 1.0 / safeDirection;
    vec3 nearPlane = (uViewerLower - origin) * inverseDirection;
    vec3 farPlane = (uViewerUpper - origin) * inverseDirection;
    vec3 minimumPlane = min(nearPlane, farPlane);
    vec3 maximumPlane = max(nearPlane, farPlane);
    return vec2(max(max(minimumPlane.x, minimumPlane.y), minimumPlane.z),
                min(min(maximumPlane.x, maximumPlane.y), maximumPlane.z));
  }

  vec3 sourceUv(vec3 viewerPosition) {
    viewerPosition -= uDisplayOffset;
    vec3 sourcePosition = vec3(viewerPosition.x, -viewerPosition.z, viewerPosition.y);
    return (sourcePosition - uSourceLower) / uSourceExtent;
  }


  vec3 legacyDisplay(vec3 linearRGB) {
    vec3 positive = max(linearRGB, vec3(0.0));
    vec3 srgb = mix(12.92 * linearRGB, 1.055 * pow(positive, vec3(1.0 / 2.4)) - 0.055,
      step(vec3(0.0031308), linearRGB));
    return clamp(srgb, 0.0, 1.0);
  }
  vec3 aces(vec3 value) {
    value *= 0.8;
    return clamp(value * (2.51 * value + 0.03) / (value * (2.43 * value + 0.59) + 0.14), 0.0, 1.0);
  }
  void main(void) {
    vec3 direction = normalize(vWorldPosition - view_position);
    vec2 hit = intersectBox(view_position, direction);
    float entry = max(hit.x, 0.0);
    float exitDistance = hit.y;
    if (uDepthEnabled > 0.5) {
      float depth = gsDepthMeters(texture2D(uProxyDepth, gl_FragCoord.xy / uViewport), uFarClip);
      float viewRayZ = -(matrix_view * vec4(direction, 0.0)).z;
      exitDistance = min(exitDistance, depth / max(viewRayZ, 1e-5) - 0.025);
    }
    if (exitDistance <= entry) discard;
    float stepLength = (exitDistance - entry) / uSteps;
    vec3 accumulatedFire = vec3(0.0);
    vec3 accumulatedSmoke = vec3(0.0);
    float transmittance = 1.0;
    for (int index = 0; index < 128; index++) {
      if (float(index) >= uSteps) break;
      vec3 position = view_position + direction * (entry + (float(index) + 0.5) * stepLength);
      vec3 uv = sourceUv(position);
      vec4 a = mix(sampleAtlas(uVolume0, uv), sampleAtlas(uVolume1, uv), uFrameAlpha);
      // Skip smoke fetches and integration in empty cells. Fixed distance increments
      // avoid skipping thin flame tongues or introducing camera-dependent flicker.
      if (a.a < 0.0001) continue;
      vec4 b = mix(sampleAtlas(uSmoke0, uv), sampleAtlas(uSmoke1, uv), uFrameAlpha);
      vec3 emission = (a.rgb * 255.0 - 128.0) * uEmissionScale;
      float sampleAlpha = 1.0 - exp(-a.a * stepLength);
      float integral = sampleAlpha / max(a.a, 1e-6);
      accumulatedFire += transmittance * emission * integral;
      accumulatedSmoke += transmittance * b.rgb * b.a * uSmokeStrength * integral;
      transmittance *= 1.0 - sampleAlpha;
      if (transmittance < 0.01) break;
    }
    float alpha = 1.0 - transmittance;
    if (alpha < 0.0001) discard;
    gl_FragColor = vec4(aces(legacyDisplay(accumulatedFire) + accumulatedSmoke), alpha);
  }
`
