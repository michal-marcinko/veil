// Minimal ambient declaration for `qrcode-svg` (no upstream types).
// We only use the QRCode constructor + .svg() method — exposing the
// minimum surface keeps this from drifting if the package adds methods.

declare module "qrcode-svg" {
  interface QRCodeOptions {
    content: string;
    padding?: number;
    width?: number;
    height?: number;
    color?: string;
    background?: string;
    ecl?: "L" | "M" | "Q" | "H";
    join?: boolean;
    /** "svg-viewbox" emits a viewBox-sized output suitable for embedding. */
    container?: "svg" | "svg-viewbox" | "g" | "none";
    pretty?: boolean;
    swap?: boolean;
    xmlDeclaration?: boolean;
  }

  class QRCode {
    constructor(options: QRCodeOptions | string);
    svg(): string;
  }

  export = QRCode;
}
