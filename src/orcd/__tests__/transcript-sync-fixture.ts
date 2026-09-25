import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type InlineExtension,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';

export interface TranscriptSyncFixture {
  cwd: string;
  agentDir: string;
  sessionDir: string;
  faux: ReturnType<typeof fauxProvider>;
  runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
  recreate(sessionFile: string): Promise<Awaited<ReturnType<typeof createAgentSessionRuntime>>>;
  dispose(): Promise<void>;
}

export async function createTranscriptSyncFixture(extension: InlineExtension): Promise<TranscriptSyncFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrel-transcript-sync-'));
  const cwd = join(dir, 'cwd');
  const agentDir = join(dir, 'agent');
  const sessionDir = join(dir, 'sessions');
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);
  const faux = fauxProvider({
    provider: 'transcript-sync-faux',
    models: [{ id: 'transcript-sync-model', contextWindow: 32_000 }],
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const createRuntime = async ({
    cwd: runtimeCwd,
    sessionManager,
    sessionStartEvent,
  }: {
    cwd: string;
    sessionManager: SessionManager;
    sessionStartEvent?: Parameters<typeof createAgentSessionFromServices>[0]['sessionStartEvent'];
  }) => {
    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir,
      modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [extension],
      },
    });
    const model = services.modelRuntime.getModel('transcript-sync-faux', 'transcript-sync-model');
    if (!model || model.provider !== 'transcript-sync-faux') {
      throw new Error('Synthetic Pi model was not selected');
    }

    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model,
        thinkingLevel: 'off',
        noTools: 'all',
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir,
    sessionManager: SessionManager.create(cwd, sessionDir),
  });

  let activeRuntime = runtime;
  return {
    cwd,
    agentDir,
    sessionDir,
    faux,
    get runtime() {
      return activeRuntime;
    },
    async recreate(sessionFile) {
      await activeRuntime.dispose();
      activeRuntime = await createAgentSessionRuntime(createRuntime, {
        cwd,
        agentDir,
        sessionManager: SessionManager.open(sessionFile, sessionDir),
      });
      return activeRuntime;
    },
    async dispose() {
      await activeRuntime.dispose();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
