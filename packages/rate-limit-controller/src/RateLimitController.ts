import {
  BaseControllerV2 as BaseController,
  RestrictedControllerMessenger,
} from '@metamask/base-controller';
import { ethErrors } from 'eth-rpc-errors';
import type { Patch } from 'immer';

/**
 * @type RateLimitState
 * @property requests - Object containing number of requests in a given interval for each origin and api type combination
 */
export type RateLimitState<
  RateLimitedApis extends Record<string, (...args: any[]) => any>,
> = {
  requests: Record<keyof RateLimitedApis, Record<string, number>>;
};

const name = 'RateLimitController';

export type RateLimitStateChange<
  RateLimitedApis extends Record<string, (...args: any[]) => any>,
> = {
  type: `${typeof name}:stateChange`;
  payload: [RateLimitState<RateLimitedApis>, Patch[]];
};

export type GetRateLimitState<
  RateLimitedApis extends Record<string, (...args: any[]) => any>,
> = {
  type: `${typeof name}:getState`;
  handler: () => RateLimitState<RateLimitedApis>;
};

export type CallApi<
  RateLimitedApis extends Record<string, (...args: any[]) => any>,
> = {
  type: `${typeof name}:call`;
  handler: RateLimitController<RateLimitedApis>['call'];
};

export type RateLimitControllerActions<
  RateLimitedApis extends Record<string, (...args: any[]) => any>,
> = GetRateLimitState<RateLimitedApis> | CallApi<RateLimitedApis>;

export type RateLimitMessenger<
  RateLimitedApis extends Record<string, (...args: any[]) => any>,
> = RestrictedControllerMessenger<
  typeof name,
  RateLimitControllerActions<RateLimitedApis>,
  RateLimitStateChange<RateLimitedApis>,
  never,
  never
>;

const metadata = {
  requests: { persist: false, anonymous: false },
};

/**
 * Controller with logic for rate-limiting API endpoints per requesting origin.
 */
export class RateLimitController<
  RateLimitedApis extends Record<string, (...args: any[]) => any>,
> extends BaseController<
  typeof name,
  RateLimitState<RateLimitedApis>,
  RateLimitMessenger<RateLimitedApis>
> {
  readonly #implementations;

  readonly #rateLimitTimeout;

  readonly #rateLimitCount;

  /**
   * Creates a RateLimitController instance.
   *
   * @param options - Constructor options.
   * @param options.messenger - A reference to the messaging system.
   * @param options.state - Initial state to set on this controller.
   * @param options.implementations - Mapping from API type to API implementation.
   * @param options.rateLimitTimeout - The time window in which the rate limit is applied (in ms).
   * @param options.rateLimitCount - The amount of calls an origin can make in the rate limit time window.
   */
  constructor({
    rateLimitTimeout = 5000,
    rateLimitCount = 1,
    messenger,
    state,
    implementations,
  }: {
    rateLimitTimeout?: number;
    rateLimitCount?: number;
    messenger: RateLimitMessenger<RateLimitedApis>;
    state?: Partial<RateLimitState<RateLimitedApis>>;
    implementations: RateLimitedApis;
  }) {
    const defaultState = {
      requests: Object.keys(implementations).reduce<
        Record<keyof RateLimitedApis, Record<string, number>>
      >((acc, key) => ({ ...acc, [key]: {} }), {}),
    };
    super({
      name,
      metadata,
      messenger,
      state: { ...defaultState, ...state },
    });
    this.#implementations = implementations;
    this.#rateLimitTimeout = rateLimitTimeout;
    this.#rateLimitCount = rateLimitCount;

    this.messagingSystem.registerActionHandler(
      `${name}:call` as const,
      (async (
        origin: string,
        type: keyof RateLimitedApis,
        ...args: Parameters<RateLimitedApis[keyof RateLimitedApis]>
      ) => this.call(origin, type, ...args)) as any,
    );
  }

  /**
   * Calls an API if the requesting origin is not rate-limited.
   *
   * @param origin - The requesting origin.
   * @param type - The type of API call to make.
   * @param args - Arguments for the API call.
   * @returns `false` if rate-limited, and `true` otherwise.
   */
  async call<ApiType extends keyof RateLimitedApis>(
    origin: string,
    type: ApiType,
    ...args: Parameters<RateLimitedApis[ApiType]>
  ): Promise<ReturnType<RateLimitedApis[ApiType]>> {
    if (this.#isRateLimited(type, origin)) {
      throw ethErrors.rpc.limitExceeded({
        message: `"${type}" is currently rate-limited. Please try again later.`,
      });
    }
    this.#recordRequest(type, origin);

    const implementation = this.#implementations[type];

    if (!implementation) {
      throw new Error('Invalid api type');
    }

    return implementation(...args);
  }

  /**
   * Checks whether an origin is rate limited for the a specific API.
   *
   * @param api - The API the origin is trying to access.
   * @param origin - The origin trying to access the API.
   * @returns `true` if rate-limited, and `false` otherwise.
   */
  #isRateLimited(api: keyof RateLimitedApis, origin: string) {
    return this.state.requests[api][origin] >= this.#rateLimitCount;
  }

  /**
   * Records that an origin has made a request to call an API, for rate-limiting purposes.
   *
   * @param api - The API the origin is trying to access.
   * @param origin - The origin trying to access the API.
   */
  #recordRequest(api: keyof RateLimitedApis, origin: string) {
    this.update((state) => {
      const previous: number = state.requests[api][origin] ?? 0;
      state.requests[api][origin] = previous + 1;

      if (previous === 0) {
        setTimeout(
          () => this.#resetRequestCount(api, origin),
          this.#rateLimitTimeout,
        );
      }
    });
  }

  /**
   * Resets the request count for a given origin and API combination, for rate-limiting purposes.
   *
   * @param api - The API in question.
   * @param origin - The origin in question.
   */
  #resetRequestCount(api: keyof RateLimitedApis, origin: string) {
    this.update((state) => {
      state.requests[api][origin] = 0;
    });
  }
}
