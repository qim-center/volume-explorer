precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 vUv;
uniform sampler2D tHdr;

void main() {
  gl_FragColor = texture2D(tHdr, vUv);
}
