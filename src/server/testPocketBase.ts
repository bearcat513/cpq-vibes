/**
 * An isolated PocketBase for the API tests.
 *
 * The tests need a real database — the storage layer is a PocketBase client
 * now, and mocking it would only prove the mock works. So this starts a
 * throwaway container from the same image Compose builds, on a random port
 * with its own empty volume: the tests never touch the data `bun run
 * docker:up` is holding, and the container is gone when they finish.
 *
 * If Docker is not available the storage-dependent tests skip rather than
 * fail, and everything that does not touch storage still runs.
 */
import { $ } from "bun";

const PB_VERSION = process.env.PB_VERSION || "0.40.4";

/**
 * Its own tag, rebuilt on every run.
 *
 * Rebuilding rather than reusing whatever is already tagged is the point: the
 * collection rules and the sharing endpoints live in docker/pb_migrations and
 * docker/pb_hooks, so a stale image would quietly test the *old* access
 * rules. Layer caching makes an unchanged rebuild take about a second.
 */
const IMAGE = `cpq-pocketbase-test:${PB_VERSION}`;

export const TEST_ADMIN_EMAIL = "test-admin@example.com";
export const TEST_ADMIN_PASSWORD = "test-password-123";

export type TestPocketBase =
  | { available: true; url: string; stop: () => Promise<void> }
  | { available: false; reason: string; url: string; stop: () => Promise<void> };

const unavailable = (reason: string): TestPocketBase => ({
  available: false,
  reason,
  // Still a plausible URL, so the server under test starts and its
  // storage-free routes answer normally.
  url: "http://127.0.0.1:1",
  stop: async () => {},
});

async function ok(command: ReturnType<typeof $>): Promise<boolean> {
  return (await command.nothrow().quiet()).exitCode === 0;
}

async function waitForHealth(url: string, attempts = 120): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if ((await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) })).ok) return true;
    } catch {
      // not listening yet
    }
    await Bun.sleep(250);
  }
  return false;
}

export async function startTestPocketBase(): Promise<TestPocketBase> {
  // An instance someone else is running (CI service container, a local one) —
  // used as-is, and never torn down by us.
  if (process.env.PB_TEST_URL) {
    const url = process.env.PB_TEST_URL.replace(/\/+$/, "");
    return (await waitForHealth(url, 8))
      ? { available: true, url, stop: async () => {} }
      : unavailable(`PB_TEST_URL is set but ${url} did not answer /api/health`);
  }

  if (!(await ok($`docker info`))) return unavailable("Docker is not running");

  const built =
    await $`docker build -f docker/pb.dockerfile --build-arg PB_VERSION=${PB_VERSION} -t ${IMAGE} docker`
      .nothrow()
      .quiet();
  if (built.exitCode !== 0) return unavailable(`could not build ${IMAGE}: ${built.stderr.toString().slice(-400)}`);

  // Port 0 lets Docker pick a free one, so a test run never collides with the
  // PocketBase from `docker compose up` or with another test run.
  const started = await $`docker run -d -p 127.0.0.1:0:8080 \
      -e PB_ADMIN_EMAIL=${TEST_ADMIN_EMAIL} -e PB_ADMIN_PASSWORD=${TEST_ADMIN_PASSWORD} ${IMAGE}`
    .nothrow()
    .quiet();
  if (started.exitCode !== 0) return unavailable(`docker run failed: ${started.stderr.toString().slice(-400)}`);

  const container = started.stdout.toString().trim();
  const stop = async () => {
    await $`docker rm -f ${container}`.nothrow().quiet();
  };

  const mapped = (await $`docker port ${container} 8080`.nothrow().quiet()).stdout.toString().trim().split("\n")[0];
  const port = mapped?.split(":").pop();
  if (!port) {
    await stop();
    return unavailable("could not read the container's published port");
  }

  const url = `http://127.0.0.1:${port}`;
  if (!(await waitForHealth(url))) {
    await stop();
    return unavailable(`PocketBase at ${url} never became healthy`);
  }

  return { available: true, url, stop };
}
