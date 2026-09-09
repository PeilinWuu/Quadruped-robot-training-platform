export const GS_DEPTH_GLSL = `
  precision highp int;
  uniform float uNearClip;
  float gsDepthMeters(vec4 packedDepth, float farClip) {
    uvec4 b = uvec4(floor(packedDepth * 255.0 + 0.5));
    uint bits = (b.r << 24u) | (b.g << 16u) | (b.b << 8u) | b.a;
    if (bits == 0xffffffffu) return farClip;
    float normalized = uintBitsToFloat(bits);
    if (isnan(normalized) || isinf(normalized) || normalized < 0.0 || normalized > 1.0) return farClip;
    return uNearClip + normalized * (farClip - uNearClip);
  }
`
