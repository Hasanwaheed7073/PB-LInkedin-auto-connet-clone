import { createServer, type Server } from 'node:http';

import { FIXTURES, SLUG_FIXTURES, type FixtureName } from './pages';

/**
 * Mock LinkedIn fixture server.
 *
 * Serves the fixture pages over real HTTP so the worker, a real Chromium and the
 * real detector can be exercised end to end. Nothing here reaches
 * linkedin.com, and `workerEnv()` refuses to point the worker at this server
 * unless NODE_ENV is `test`.
 *
 * Routes:
 *   GET /feed            -> whatever the current session fixture is
 *   GET /in/<slug>       -> the fixture mapped from the slug (see SLUG_FIXTURES)
 *   GET /checkpoint/...  -> security challenge (URL-based detection)
 *   POST /__control      -> switch the session fixture at runtime
 *   GET /__health        -> readiness probe
 *
 * Run standalone with `npm run mock:linkedin`, or embed it in a test with
 * `startMockLinkedIn()`.
 */

export interface MockLinkedInHandle {
  url: string;
  port: number;
  /** Change what /feed returns, to simulate the session going bad mid-run. */
  setSessionFixture(name: FixtureName): void;
  /** Override the fixture for one slug. */
  setSlugFixture(slug: string, name: FixtureName): void;
  /** Requests seen, for assertions about what the worker actually visited. */
  requests(): { method: string; path: string }[];
  reset(): void;
  close(): Promise<void>;
}

export function createMockLinkedInServer(): { server: Server; handle: Omit<MockLinkedInHandle, 'url' | 'port' | 'close'> } {
  let sessionFixture: FixtureName = 'feed-authenticated';
  const slugOverrides = new Map<string, FixtureName>();
  const seen: { method: string; path: string }[] = [];

  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    seen.push({ method, path });

    const send = (status: number, body: string, contentType = 'text/html; charset=utf-8') => {
      res.writeHead(status, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      });
      res.end(body);
    };

    // --- Test control plane ---------------------------------------------
    if (path === '/__health') {
      return send(200, JSON.stringify({ ok: true }), 'application/json');
    }

    if (path === '/__control' && method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        try {
          const body = JSON.parse(raw || '{}') as {
            sessionFixture?: FixtureName;
            slug?: string;
            fixture?: FixtureName;
            reset?: boolean;
          };
          if (body.reset) {
            sessionFixture = 'feed-authenticated';
            slugOverrides.clear();
            seen.length = 0;
          }
          if (body.sessionFixture) sessionFixture = body.sessionFixture;
          if (body.slug && body.fixture) slugOverrides.set(body.slug, body.fixture);
          send(200, JSON.stringify({ ok: true }), 'application/json');
        } catch {
          send(400, JSON.stringify({ ok: false }), 'application/json');
        }
      });
      return undefined;
    }

    // --- Session ---------------------------------------------------------
    if (path === '/feed' || path === '/feed/' || path === '/') {
      return send(200, FIXTURES[sessionFixture]);
    }

    // --- URL-pattern security states ------------------------------------
    // These exist so the URL-based detector rules are exercised, not only the
    // DOM-based ones.
    if (path.startsWith('/checkpoint/challenge')) {
      return send(200, FIXTURES.captcha);
    }
    if (path.startsWith('/checkpoint/restricted')) {
      return send(200, FIXTURES['account-restricted']);
    }
    if (path.startsWith('/checkpoint')) {
      return send(200, FIXTURES['security-challenge']);
    }
    if (path === '/login' || path.startsWith('/uas/login') || path.startsWith('/authwall')) {
      return send(200, FIXTURES['login-required']);
    }

    // --- Profiles --------------------------------------------------------
    const profileMatch = /^\/in\/([^/]+)\/?$/.exec(path);
    if (profileMatch) {
      const slug = decodeURIComponent(profileMatch[1]!).toLowerCase();
      const fixture = slugOverrides.get(slug) ?? SLUG_FIXTURES[slug];

      if (!fixture) {
        // An unmapped slug behaves like a missing profile.
        return send(404, FIXTURES['profile-not-found']);
      }
      if (fixture === 'profile-not-found') {
        return send(404, FIXTURES['profile-not-found']);
      }
      return send(200, FIXTURES[fixture]);
    }

    return send(404, FIXTURES['profile-not-found']);
  });

  return {
    server,
    handle: {
      setSessionFixture(name) {
        sessionFixture = name;
      },
      setSlugFixture(slug, name) {
        slugOverrides.set(slug.toLowerCase(), name);
      },
      requests() {
        return [...seen];
      },
      reset() {
        sessionFixture = 'feed-authenticated';
        slugOverrides.clear();
        seen.length = 0;
      },
    },
  };
}

/** Start on an ephemeral port (0) unless one is given. */
export async function startMockLinkedIn(port = 0): Promise<MockLinkedInHandle> {
  const { server, handle } = createMockLinkedInServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    ...handle,
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// Standalone entry point: `npm run mock:linkedin`
const isDirectRun =
  process.argv[1] !== undefined && /mock-linkedin[\\/]server\.ts$/.test(process.argv[1]);

if (isDirectRun) {
  const port = Number(process.env.MOCK_LINKEDIN_PORT ?? 4010);
  void startMockLinkedIn(port).then((handle) => {
    process.stdout.write(
      `Mock LinkedIn fixture server listening on ${handle.url}\n` +
        `\nProfiles:\n` +
        Object.keys(SLUG_FIXTURES)
          .map((slug) => `  ${handle.url}/in/${slug}`)
          .join('\n') +
        `\n\nThis serves local fixtures only. It never contacts linkedin.com.\n`,
    );
  });
}
