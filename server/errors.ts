export class BridgeError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}
export const conflict = (message: string) => new BridgeError(409, 'CONFLICT', message);
export const invalid = (message: string) => new BridgeError(400, 'INVALID_REQUEST', message);
export const missing = (message: string) => new BridgeError(404, 'NOT_FOUND', message);
