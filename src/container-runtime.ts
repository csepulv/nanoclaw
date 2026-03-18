/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'container';

/**
 * Hostname/IP containers use to reach the host machine.
 * Apple Container (macOS): query `container network ls` for the default gateway IP.
 * Docker Desktop (macOS/WSL): host.docker.internal resolves automatically.
 * Docker (Linux): host.docker.internal added via --add-host.
 */
export const CONTAINER_HOST_GATEWAY = detectHostGateway();

function detectHostGateway(): string {
  if (process.env.CONTAINER_HOST_GATEWAY)
    return process.env.CONTAINER_HOST_GATEWAY;

  // Apple Container: query the runtime for the default network's gateway IP
  if (CONTAINER_RUNTIME_BIN === 'container') {
    try {
      const output = execSync('container network ls --format json', {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 5000,
      });
      const networks: {
        id: string;
        status?: { ipv4Gateway?: string };
      }[] = JSON.parse(output || '[]');
      const defaultNet = networks.find((n) => n.id === 'default');
      if (defaultNet?.status?.ipv4Gateway) {
        logger.debug(
          { gateway: defaultNet.status.ipv4Gateway },
          'Detected Apple Container gateway',
        );
        return defaultNet.status.ipv4Gateway;
      }
    } catch (err) {
      logger.warn(
        { err },
        'Failed to detect Apple Container gateway, using fallback',
      );
    }
    return '192.168.64.1';
  }

  return 'host.docker.internal';
}

/**
 * Address the credential proxy binds to.
 * Apple Container (macOS): bind to 0.0.0.0 — the bridge100 interface may not
 *   exist at module load time, so we listen on all interfaces.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  // Apple Container: bind all interfaces since bridge100 is created dynamically
  if (CONTAINER_RUNTIME_BIN === 'container') return '0.0.0.0';

  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return [
    '--mount',
    `type=bind,source=${hostPath},target=${containerPath},readonly`,
  ];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/**
 * Ensure the container runtime is running, starting it if needed.
 * Retries up to maxRetries times with retryDelayMs intervals to handle
 * boot-time startup where Apple Container services may not be ready immediately.
 */
export function ensureContainerRuntimeRunning(
  maxRetries = 10,
  retryDelayMs = 5000,
): void {
  const MAX_RETRIES = maxRetries;
  const RETRY_DELAY_MS = retryDelayMs;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
      logger.debug('Container runtime already running');
      return;
    } catch {
      // Not running — try to start it
    }

    logger.info({ attempt, maxRetries: MAX_RETRIES }, 'Starting container runtime...');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      // Verify it actually started
      execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
      logger.info('Container runtime started');
      return;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        logger.warn(
          { attempt, err },
          `Container runtime not ready, retrying in ${RETRY_DELAY_MS / 1000}s...`,
        );
        const waitUntil = Date.now() + RETRY_DELAY_MS;
        while (Date.now() < waitUntil) {
          /* busy-wait — execSync is synchronous context */
        }
      } else {
        logger.error({ err }, 'Failed to start container runtime after all retries');
        console.error(
          '\n╔════════════════════════════════════════════════════════════════╗',
        );
        console.error(
          '║  FATAL: Container runtime failed to start                      ║',
        );
        console.error(
          '║                                                                ║',
        );
        console.error(
          '║  Agents cannot run without a container runtime. To fix:        ║',
        );
        console.error(
          '║  1. Ensure Apple Container is installed                        ║',
        );
        console.error(
          '║  2. Run: container system start                                ║',
        );
        console.error(
          '║  3. Restart NanoClaw                                           ║',
        );
        console.error(
          '╚════════════════════════════════════════════════════════════════╝\n',
        );
        throw new Error('Container runtime is required but failed to start');
      }
    }
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: { status: string; configuration: { id: string } }[] =
      JSON.parse(output || '[]');
    const orphans = containers
      .filter(
        (c) =>
          c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'),
      )
      .map((c) => c.configuration.id);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
