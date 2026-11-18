export class SafeFailure extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
    this.name = "SafeFailure";
  }
}
