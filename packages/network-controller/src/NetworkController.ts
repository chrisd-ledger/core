import EthQuery from 'eth-query';
import Subprovider from 'web3-provider-engine/subproviders/provider';
import createInfuraProvider from 'eth-json-rpc-infura/src/createProvider';
import createMetamaskProvider from 'web3-provider-engine/zero';
import { Mutex } from 'async-mutex';
import { v4 as random } from 'uuid';
import type { Patch } from 'immer';
import {
  BaseControllerV2,
  RestrictedControllerMessenger,
} from '@metamask/base-controller';
import {
  MAINNET,
  RPC,
  TESTNET_NETWORK_TYPE_TO_TICKER_SYMBOL,
  NetworksChainId,
  NetworkType,
} from '@metamask/controller-utils';

/**
 * @type ProviderConfig
 *
 * Configuration passed to web3-provider-engine
 * @property rpcTarget - RPC target URL.
 * @property type - Human-readable network name.
 * @property chainId - Network ID as per EIP-155.
 * @property ticker - Currency ticker.
 * @property nickname - Personalized network name.
 */
export type ProviderConfig = {
  rpcTarget?: string;
  type: NetworkType;
  chainId: string;
  ticker?: string;
  nickname?: string;
};

export type Block = {
  baseFeePerGas?: string;
};

export type NetworkDetails = {
  isEIP1559Compatible?: boolean;
};

/**
 * Custom RPC network information
 *
 * @property rpcUrl - RPC target URL.
 * @property chainId - Network ID as per EIP-155
 * @property nickname - Personalized network name.
 * @property ticker - Currency ticker.
 * @property rpcPrefs - Personalized preferences.
 */
export type NetworkConfiguration = {
  rpcUrl: string;
  chainId?: string;
  nickname?: string;
  ticker?: string;
  rpcPrefs?: {
    blockExplorerUrl: string;
  };
};

/**
 * @type NetworkState
 *
 * Network controller state
 * @property network - Network ID as per net_version of the currently connected network
 * @property isCustomNetwork - Identifies if the currently connected network is a custom network
 * @property providerConfig - RPC URL and network name provider settings of the currently connected network
 * @property properties - an additional set of network properties for the currently connected network
 * @property networkConfigurations - the full list of configured networks either preloaded or added by the user.
 */
export type NetworkState = {
  network: string;
  isCustomNetwork: boolean;
  providerConfig: ProviderConfig;
  networkDetails: NetworkDetails;
  networkConfigurations: Record<string, NetworkConfiguration>;
};

const LOCALHOST_RPC_URL = 'http://localhost:8545';

const name = 'NetworkController';

export type EthQuery = any;

export type NetworkControllerStateChangeEvent = {
  type: `NetworkController:stateChange`;
  payload: [NetworkState, Patch[]];
};

export type NetworkControllerProviderConfigChangeEvent = {
  type: `NetworkController:providerConfigChange`;
  payload: [ProviderConfig];
};

export type NetworkControllerEvents =
  | NetworkControllerStateChangeEvent
  | NetworkControllerProviderConfigChangeEvent;

export type NetworkControllerGetProviderConfigAction = {
  type: `NetworkController:getProviderConfig`;
  handler: () => ProviderConfig;
};

export type NetworkControllerGetEthQueryAction = {
  type: `NetworkController:getEthQuery`;
  handler: () => EthQuery;
};

export type NetworkControllerActions =
  | NetworkControllerGetProviderConfigAction
  | NetworkControllerGetEthQueryAction;

export type NetworkControllerMessenger = RestrictedControllerMessenger<
  typeof name,
  NetworkControllerGetProviderConfigAction | NetworkControllerGetEthQueryAction,
  | NetworkControllerStateChangeEvent
  | NetworkControllerProviderConfigChangeEvent,
  string,
  string
>;

export type NetworkControllerOptions = {
  messenger: NetworkControllerMessenger;
  infuraProjectId?: string;
  state?: Partial<NetworkState>;
};

export const defaultState: NetworkState = {
  network: 'loading',
  isCustomNetwork: false,
  providerConfig: { type: MAINNET, chainId: NetworksChainId.mainnet },
  networkDetails: { isEIP1559Compatible: false },
  networkConfigurations: {},
};

/**
 * Controller that creates and manages an Ethereum network provider.
 */
export class NetworkController extends BaseControllerV2<
  typeof name,
  NetworkState,
  NetworkControllerMessenger
> {
  private ethQuery: EthQuery;

  private internalProviderConfig: ProviderConfig = {} as ProviderConfig;

  private infuraProjectId: string | undefined;

  private mutex = new Mutex();

  constructor({ messenger, state, infuraProjectId }: NetworkControllerOptions) {
    super({
      name,
      metadata: {
        network: {
          persist: true,
          anonymous: false,
        },
        isCustomNetwork: {
          persist: true,
          anonymous: false,
        },
        networkDetails: {
          persist: true,
          anonymous: false,
        },
        providerConfig: {
          persist: true,
          anonymous: false,
        },
        networkConfigurations: {
          persist: true,
          anonymous: false,
        },
      },
      messenger,
      state: { ...defaultState, ...state },
    });
    this.infuraProjectId = infuraProjectId;
    this.messagingSystem.registerActionHandler(
      `${this.name}:getProviderConfig`,
      () => {
        return this.state.providerConfig;
      },
    );

    this.messagingSystem.registerActionHandler(
      `${this.name}:getEthQuery`,
      () => {
        return this.ethQuery;
      },
    );
  }

  private initializeProvider(
    type: NetworkType,
    rpcTarget?: string,
    chainId?: string,
    ticker?: string,
    nickname?: string,
  ) {
    this.update((state) => {
      state.isCustomNetwork = this.getIsCustomNetwork(chainId);
    });

    switch (type) {
      case MAINNET:
      case 'goerli':
      case 'sepolia':
        this.setupInfuraProvider(type);
        break;
      case 'localhost':
        this.setupStandardProvider(LOCALHOST_RPC_URL);
        break;
      case RPC:
        rpcTarget &&
          this.setupStandardProvider(rpcTarget, chainId, ticker, nickname);
        break;
      default:
        throw new Error(`Unrecognized network type: '${type}'`);
    }
    this.getEIP1559Compatibility();
  }

  private refreshNetwork() {
    this.update((state) => {
      state.network = 'loading';
      state.networkDetails = {};
    });
    const { rpcTarget, type, chainId, ticker } = this.state.providerConfig;
    this.initializeProvider(type, rpcTarget, chainId, ticker);
    this.lookupNetwork();
  }

  private registerProvider() {
    this.provider.on('error', this.verifyNetwork.bind(this));
    this.ethQuery = new EthQuery(this.provider);
  }

  private setupInfuraProvider(type: NetworkType) {
    const infuraProvider = createInfuraProvider({
      network: type,
      projectId: this.infuraProjectId,
    });
    const infuraSubprovider = new Subprovider(infuraProvider);
    const config = {
      ...this.internalProviderConfig,
      ...{
        dataSubprovider: infuraSubprovider,
        engineParams: {
          blockTrackerProvider: infuraProvider,
          pollingInterval: 12000,
        },
      },
    };
    this.updateProvider(createMetamaskProvider(config));
  }

  private getIsCustomNetwork(chainId?: string) {
    return (
      chainId !== NetworksChainId.mainnet &&
      chainId !== NetworksChainId.goerli &&
      chainId !== NetworksChainId.sepolia &&
      chainId !== NetworksChainId.localhost
    );
  }

  private setupStandardProvider(
    rpcTarget: string,
    chainId?: string,
    ticker?: string,
    nickname?: string,
  ) {
    const config = {
      ...this.internalProviderConfig,
      ...{
        chainId,
        engineParams: { pollingInterval: 12000 },
        nickname,
        rpcUrl: rpcTarget,
        ticker,
      },
    };
    this.updateProvider(createMetamaskProvider(config));
  }

  private updateProvider(provider: any) {
    this.safelyStopProvider(this.provider);
    this.provider = provider;
    this.registerProvider();
  }

  private safelyStopProvider(provider: any) {
    setTimeout(() => {
      provider?.stop();
    }, 500);
  }

  private verifyNetwork() {
    this.state.network === 'loading' && this.lookupNetwork();
  }

  /**
   * Ethereum provider object for the current network
   */
  provider: any;

  /**
   * Sets a new configuration for web3-provider-engine.
   *
   * TODO: Replace this wth a method.
   *
   * @param providerConfig - The web3-provider-engine configuration.
   */
  set providerConfig(providerConfig: ProviderConfig) {
    this.internalProviderConfig = providerConfig;
    const { type, rpcTarget, chainId, ticker, nickname } =
      this.state.providerConfig;
    this.initializeProvider(type, rpcTarget, chainId, ticker, nickname);
    if (this.provider !== undefined) {
      this.registerProvider();
    }
    this.lookupNetwork();
  }

  get providerConfig() {
    throw new Error('Property only used for setting');
  }

  async #getNetworkId(): Promise<string> {
    return await new Promise((resolve, reject) => {
      this.ethQuery.sendAsync(
        { method: 'net_version' },
        (error: Error, result: string) => {
          if (error) {
            reject(error);
          } else {
            resolve(result);
          }
        },
      );
    });
  }

  /**
   * Refreshes the current network code.
   */
  async lookupNetwork() {
    if (!this.ethQuery || !this.ethQuery.sendAsync) {
      return;
    }
    const releaseLock = await this.mutex.acquire();

    try {
      try {
        const networkId = await this.#getNetworkId();
        if (this.state.network === networkId) {
          return;
        }

        this.update((state) => {
          state.network = networkId;
        });
      } catch (_error) {
        this.update((state) => {
          state.network = 'loading';
        });
      }

      this.messagingSystem.publish(
        `NetworkController:providerConfigChange`,
        this.state.providerConfig,
      );
    } finally {
      releaseLock();
    }
  }

  /**
   * Convenience method to update provider network type settings.
   *
   * @param type - Human readable network name.
   */
  setProviderType(type: NetworkType) {
    // If testnet the ticker symbol should use a testnet prefix
    const ticker =
      type in TESTNET_NETWORK_TYPE_TO_TICKER_SYMBOL &&
      TESTNET_NETWORK_TYPE_TO_TICKER_SYMBOL[type].length > 0
        ? TESTNET_NETWORK_TYPE_TO_TICKER_SYMBOL[type]
        : 'ETH';

    this.update((state) => {
      state.providerConfig.type = type;
      state.providerConfig.ticker = ticker;
      state.providerConfig.chainId = NetworksChainId[type];
      state.providerConfig.rpcTarget = undefined;
      state.providerConfig.nickname = undefined;
    });
    this.refreshNetwork();
  }

  /**
   * Convenience method to update provider RPC settings.
   *
   * @param rpcTarget - The RPC endpoint URL.
   * @param chainId - The chain ID as per EIP-155.
   * @param ticker - The currency ticker.
   * @param nickname - Personalized network name.
   */
  setRpcTarget(
    rpcTarget: string,
    chainId: string,
    ticker?: string,
    nickname?: string,
  ) {
    this.update((state) => {
      state.providerConfig.type = RPC;
      state.providerConfig.rpcTarget = rpcTarget;
      state.providerConfig.chainId = chainId;
      state.providerConfig.ticker = ticker;
      state.providerConfig.nickname = nickname;
    });
    this.refreshNetwork();
  }

  getEIP1559Compatibility() {
    const { networkDetails = {} } = this.state;

    if (!networkDetails.isEIP1559Compatible) {
      if (typeof this.ethQuery?.sendAsync !== 'function') {
        return Promise.resolve(true);
      }
      return new Promise((resolve, reject) => {
        this.ethQuery.sendAsync(
          { method: 'eth_getBlockByNumber', params: ['latest', false] },
          (error: Error, block: Block) => {
            if (error) {
              reject(error);
            } else {
              const isEIP1559Compatible =
                typeof block.baseFeePerGas !== 'undefined';
              if (networkDetails.isEIP1559Compatible !== isEIP1559Compatible) {
                this.update((state) => {
                  state.networkDetails.isEIP1559Compatible =
                    isEIP1559Compatible;
                });
              }
              resolve(isEIP1559Compatible);
            }
          },
        );
      });
    }
    return Promise.resolve(true);
  }

  /**
   * Network Configuration management functions
   */

  /**
   * Adds a network configuration if the rpcUrl is not already present on an
   * existing network configuration. Otherwise updates the entry with the matching rpcUrl.
   *
   * @param config - The network configuration.
   * @param config.rpcUrl - The network configuration RPC URL.
   * @param config.chainId - The chain ID of the network, as per EIP-155.
   * @param config.ticker - Currency ticker.
   * @param config.nickname - Personalized network name.
   * @param config.rpcPrefs - Personalized preferences.
   * @returns uuid for the added or updated network configuration
   */
  upsertNetworkConfiguration({
    rpcUrl,
    chainId,
    ticker,
    nickname,
    rpcPrefs,
  }: NetworkConfiguration): string {
    const newNetworkConfiguration = {
      rpcUrl,
      chainId,
      ticker,
      nickname,
      rpcPrefs,
    };

    for (const [configUUID, networkConfiguration] of Object.entries(
      this.state.networkConfigurations,
    )) {
      if (networkConfiguration.rpcUrl.toLowerCase() === rpcUrl.toLowerCase()) {
        this.update((state) => {
          state.networkConfigurations[configUUID] = newNetworkConfiguration;
        });
        return configUUID;
      }
    }

    const uuid = random();
    this.update((state) => {
      state.networkConfigurations[uuid] = newNetworkConfiguration;
    });

    return uuid;
  }

  /**
   * Removes network configuration from state.
   *
   * @param uuid - Custom RPC URL.
   */
  removeNetworkConfiguration(uuid: string) {
    this.update((state) => {
      delete state.networkConfigurations[uuid];
    });
  }
}

export default NetworkController;
