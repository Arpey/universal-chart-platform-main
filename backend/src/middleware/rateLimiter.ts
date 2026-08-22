import type { RequestHandler } from 'express'
export const rateLimiter: RequestHandler = (_req, _res, next) => next()
