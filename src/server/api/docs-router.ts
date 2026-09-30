import { readFileSync } from 'fs';
import { Router, type Request, type Response } from 'express';

/**
 * Swagger UI and the OpenAPI spec, mounted lazily.
 *
 * Nothing but these two docs routes uses either one, so the spec is read per request and
 * swagger-ui-express — megabytes of JS that only the docs page needs — is imported on the
 * first hit. A spec that has not been generated yet is a 404, so a checkout that has never
 * run `tsoa:generate` still boots and serves its API.
 */
export function mountDocs(router: Router, specPath: string): void {
  const readSpec = (): unknown => {
    let spec: unknown = null;
    try {
      spec = JSON.parse(readFileSync(specPath, 'utf-8'));
    } catch (err) {
      console.warn(`[docs] ${specPath} is unavailable:`, err instanceof Error ? err.message : String(err));
    }
    return spec;
  };

  // Handlers land here on the first request, so express keeps doing the routing.
  const docs = Router();
  let ready = false;

  const loadDocs = async (): Promise<boolean> => {
    const spec = readSpec();
    if (spec !== null) {
      const swaggerUi = await import('swagger-ui-express');
      docs.use(swaggerUi.serve, swaggerUi.setup(spec));
    }
    return spec !== null;
  };

  router.get('/api/docs/swagger.json', (_req: Request, res: Response) => {
    const spec = readSpec();
    if (spec === null) {
      res.status(404).json({ error: 'OpenAPI spec not generated yet' });
    } else {
      res.json(spec);
    }
  });

  router.use('/api/docs', (req: Request, res: Response, next) => {
    if (ready) {
      docs(req, res, next);
    } else {
      void loadDocs()
        .then((loaded) => {
          if (loaded) {
            ready = true;
            docs(req, res, next);
          } else {
            res.status(404).json({ error: 'OpenAPI spec not generated yet' });
          }
        })
        .catch(next);
    }
  });
}
