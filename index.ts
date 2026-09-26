import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../../auth/guards';
import { adminDashboardRoutes } from './dashboard';
import { adminPeopleRoutes } from './people';
import { adminCatalogRoutes } from './catalog';
import { adminTripRoutes } from './trips';
import { adminFinanceRoutes } from './finance';
import { adminMarketingRoutes } from './marketing';
import { adminSystemRoutes } from './system';

/** Every admin endpoint requires an admin session; each route then checks its own permission. */
export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', requireAuth('ADMIN'));
  await app.register(adminDashboardRoutes);
  await app.register(adminPeopleRoutes);
  await app.register(adminCatalogRoutes);
  await app.register(adminTripRoutes);
  await app.register(adminFinanceRoutes);
  await app.register(adminMarketingRoutes);
  await app.register(adminSystemRoutes);
};
