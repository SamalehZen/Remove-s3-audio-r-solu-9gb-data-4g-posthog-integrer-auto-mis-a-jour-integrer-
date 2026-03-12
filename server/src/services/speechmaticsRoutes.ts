import type { FastifyInstance } from 'fastify'
import { speechmaticsClient } from '../clients/speechmaticsClient.js'
import type { SupabaseJwtPayload } from '../auth/supabaseJwt.js'

export const registerSpeechmaticsRoutes = async (
  fastify: FastifyInstance,
  options: { requireAuth: boolean },
) => {
  const { requireAuth } = options

  fastify.post('/speechmatics/temp-jwt', async (request, reply) => {
    try {
      const user = (request as any).user as SupabaseJwtPayload | undefined
      if (requireAuth && !user?.sub) {
        reply.code(401).send({ success: false, error: 'Unauthorized' })
        return
      }

      if (!speechmaticsClient || !speechmaticsClient.isAvailable) {
        reply.code(503).send({ success: false, error: 'Speechmatics not configured' })
        return
      }

      const jwt = await speechmaticsClient.createTemporaryJWT(60)

      reply.send({
        success: true,
        jwt,
        expires_in_seconds: 60,
      })
    } catch (error: any) {
      console.error('Failed to generate Speechmatics temp JWT:', error)
      reply.code(500).send({
        success: false,
        error: error?.message || 'Failed to generate temporary JWT',
      })
    }
  })
}
