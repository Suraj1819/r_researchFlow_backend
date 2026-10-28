
export function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  const isProduction = process.env.NODE_ENV === 'production';

  // Log unexpected errors without exposing internal details to clients.
  if (!isProduction || !err.status || err.status >= 500) {
    console.error('[error]', {
      method: req.method,
      path: req.originalUrl || req.url,
      status: err.status || 500,
      code: err.code || 'INTERNAL_ERROR',
      message: err.message,
    });
  }

  // Zod validation errors
  if (err.name === 'ZodError' && Array.isArray(err.issues)) {
    const fieldErrors = {};

    for (const issue of err.issues) {
      const path = issue.path.length
        ? issue.path.join('.')
        : '_root';

      // Preserve multiple validation errors for the same field.
      if (!fieldErrors[path]) {
        fieldErrors[path] = [];
      }

      fieldErrors[path].push(issue.message);
    }

    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        fieldErrors,
      },
    });
  }

  // Malformed JSON body
  if (
    err.type === 'entity.parse.failed' &&
    err.status === 400
  ) {
    return res.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'The request body contains invalid JSON.',
      },
    });
  }

  // Request body exceeds configured parser limit
  if (
    err.type === 'entity.too.large' ||
    err.status === 413
  ) {
    return res.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'The request body is too large.',
      },
    });
  }

  // CORS rejection
  if (err.message === 'Origin not allowed by CORS.') {
    return res.status(403).json({
      error: {
        code: 'CORS_ORIGIN_DENIED',
        message: 'This origin is not allowed to access the API.',
      },
    });
  }

  // Known application errors
  if (
    Number.isInteger(err.status) &&
    err.status >= 400 &&
    err.status <= 599
  ) {
    const status = err.status;

    return res.status(status).json({
      error: {
        code:
          typeof err.code === 'string' && err.code.trim()
            ? err.code
            : getDefaultErrorCode(status),
        message:
          status >= 500 && isProduction
            ? 'An unexpected server error occurred.'
            : err.message || 'The request could not be completed.',
        ...(err.fieldErrors
          ? { fieldErrors: err.fieldErrors }
          : {}),
      },
    });
  }

  // Generic unexpected error
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: isProduction
        ? 'An unexpected server error occurred.'
        : err.message || 'An unexpected error occurred.',
    },
  });
}

function getDefaultErrorCode(status) {
  const codes = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    405: 'METHOD_NOT_ALLOWED',
    409: 'CONFLICT',
    410: 'GONE',
    413: 'PAYLOAD_TOO_LARGE',
    415: 'UNSUPPORTED_MEDIA_TYPE',
    422: 'UNPROCESSABLE_ENTITY',
    429: 'RATE_LIMITED',
  };

  return codes[status] || 'INTERNAL_ERROR';
}

/**
 * Helper to create structured application errors.
 *
 * Usage:
 * throw AppError(404, 'NOT_FOUND', 'Project not found.');
 */
export function AppError(status, code, message, fieldErrors) {
  const err = new Error(message);

  err.status = status;
  err.code = code;

  if (fieldErrors) {
    err.fieldErrors = fieldErrors;
  }

  return err;
}
