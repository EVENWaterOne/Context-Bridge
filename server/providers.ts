import { PROVIDER_LABELS, type CodexStatus, type ProviderId } from '../src/lib/backend-types.ts';
import type { CodexLogin, CodexProvider, CodexRunRequest, CodexRunResult } from './provider.ts';
import { invalid } from './errors.ts';

export const isProviderId = (value: unknown): value is ProviderId => typeof value === 'string' && Object.hasOwn(PROVIDER_LABELS, value);
export type ProviderFactory = () => CodexProvider | Promise<CodexProvider>;

/**
 * Routes status, login and runs to the provider the user selected. Providers are
 * created on first use, so choosing Claude Code never starts the Codex process and
 * vice versa. Jobs keep one run at a time; the app refuses to switch while one runs.
 */
export class ProviderSwitch implements CodexProvider {
  #factories: Partial<Record<ProviderId, ProviderFactory>>;
  #instances = new Map<ProviderId, Promise<CodexProvider>>();
  #active: ProviderId;
  #closed = false;

  constructor(factories: Partial<Record<ProviderId, ProviderFactory>>, active: ProviderId) {
    this.#factories = factories;
    const ids = this.ids;
    if (!ids.length) throw new Error('At least one model provider is required');
    this.#active = ids.includes(active) ? active : ids[0];
  }

  get ids(): ProviderId[] { return (Object.keys(PROVIDER_LABELS) as ProviderId[]).filter(id => this.#factories[id]); }
  get active(): ProviderId { return this.#active; }
  get label(): string { return PROVIDER_LABELS[this.#active]; }

  /** Validates a provider choice without switching. */
  check(id: unknown): ProviderId {
    if (!isProviderId(id) || !this.#factories[id]) throw invalid('Choose an available AI provider.');
    return id;
  }

  select(id: unknown): ProviderId {
    this.#active = this.check(id);
    return this.#active;
  }

  provider(id: ProviderId = this.#active): Promise<CodexProvider> {
    if (this.#closed) return Promise.reject(new Error('Model providers are closed'));
    const factory = this.#factories[id];
    if (!factory) return Promise.reject(invalid('Choose an available AI provider.'));
    let instance = this.#instances.get(id);
    if (!instance) {
      instance = Promise.resolve().then(factory);
      // A failed import or constructor may be retried by the next request.
      instance.catch(() => { if (this.#instances.get(id) === instance) this.#instances.delete(id); });
      this.#instances.set(id, instance);
    }
    return instance;
  }

  async status(): Promise<CodexStatus> {
    const label = this.label;
    try { return await (await this.provider()).status(); }
    catch (error) { return { available: false, authenticated: false, models: [], account: null, error: `${label} could not start: ${error instanceof Error ? error.message : String(error)}` }; }
  }
  async login(): Promise<CodexLogin> { return (await this.provider()).login(); }
  async run(request: CodexRunRequest): Promise<CodexRunResult> { return (await this.provider()).run(request); }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#instances.values()].map(async instance => (await instance).close()));
  }
}
