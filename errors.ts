export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  badRequest: (code: string, message: string, details?: unknown) => new AppError(400, code, message, details),
  unauthorized: (message = 'يجب تسجيل الدخول') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'ليس لديك صلاحية لتنفيذ هذا الإجراء') => new AppError(403, 'FORBIDDEN', message),
  notFound: (message = 'العنصر غير موجود') => new AppError(404, 'NOT_FOUND', message),
  conflict: (code: string, message: string) => new AppError(409, code, message),
  tooMany: (code: string, message: string, details?: unknown) => new AppError(429, code, message, details),
  unavailable: (code: string, message: string, details?: unknown) => new AppError(503, code, message, details),
};
