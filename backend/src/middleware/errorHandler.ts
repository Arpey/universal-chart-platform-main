import type { ErrorRequestHandler } from 'express'
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => res.status(500).json({ message: error instanceof Error ? error.message : 'Internal server error' })
