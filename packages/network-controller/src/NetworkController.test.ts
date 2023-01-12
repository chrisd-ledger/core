import assert from 'assert';
import { isDeepStrictEqual } from 'util';
import { mocked } from 'ts-jest/utils';
import { ControllerMessenger } from '@metamask/base-controller';
import * as ethQueryModule from 'eth-query';
import Subprovider from 'web3-provider-engine/subproviders/provider';
import createInfuraProvider from 'eth-json-rpc-infura/src/createProvider';
import type { ProviderEngine } from 'web3-provider-engine';
import createMetamaskProvider from 'web3-provider-engine/zero';
import { Patch } from 'immer';
import { waitForResult } from '../../../tests/helpers';
import {
  FakeProviderEngine,
  FakeProviderStub,
} from '../tests/fake-provider-engine';
import {
  NetworkController,
  NetworkControllerActions,
  NetworkControllerEvents,
  NetworkControllerMessenger,
  NetworkControllerOptions,
  NetworkState,
  ProviderConfig,
} from './NetworkController';

jest.mock('eth-query', () => {
  return {
    __esModule: true,
    default: jest.requireActual('eth-query'),
  };
});
jest.mock('web3-provider-engine/subproviders/provider');
jest.mock('eth-json-rpc-infura/src/createProvider');
jest.mock('web3-provider-engine/zero');

// Store this up front so it doesn't get lost when it is stubbed
const originalSetTimeout = global.setTimeout;

const SubproviderMock = mocked(Subprovider);
const createInfuraProviderMock = mocked(createInfuraProvider);
const createMetamaskProviderMock = mocked(createMetamaskProvider);

//                                                                                     setProviderType            setRpcTarget
//                                                                                            └───────────┬────────────┘
// set providerConfig                                                                               refreshNetwork
//       │ │ └────────────────────────────────────────────┬──────────────────────────────────────────────┘ │
//       │ │                                     initializeProvider                                        │
//       │ │                  ┌─────────────────────────┘ │ └─────────────────────────┐                    │
//       │ │          setupInfuraProvider        setupStandardProvider      getEIP1559Compatibility        │
//       │ │                  └─────────────┬─────────────┘                                                │
//       │ │                          updateProvider                                                       │
//       │ └───────────────┬───────────────┘ └───────────────────────────────┐                             │
//       │          registerProvider                                  this.provider = ...                  │
//       │                 ⋮                                                                               │
//       │   this.provider.on('error', ...)                                                                │
//       │                 │                                                                               │
//       │            verifyNetwork                                                                        │
//       │                 └─────────────────────────────┐                                                 │
//       └───────────────────────────────────────────────┼─────────────────────────────────────────────────┘
//                                                 lookupNetwork

describe('NetworkController', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('initializes the state with some defaults', async () => {
      await withController(({ controller }) => {
        expect(controller.state).toStrictEqual({
          network: 'loading',
          isCustomNetwork: false,
          providerConfig: { type: 'mainnet' as const, chainId: '1' },
          properties: { isEIP1559Compatible: false },
        });
      });
    });

    it('merges the given state into the default state', async () => {
      await withController(
        {
          state: {
            isCustomNetwork: true,
            properties: { isEIP1559Compatible: true },
          },
        },
        ({ controller }) => {
          expect(controller.state).toStrictEqual({
            network: 'loading',
            isCustomNetwork: true,
            providerConfig: { type: 'mainnet', chainId: '1' },
            properties: { isEIP1559Compatible: true },
          });
        },
      );
    });
  });

  describe('providerConfig property', () => {
    describe('get', () => {
      it('throws', async () => {
        await withController(({ controller }) => {
          expect(() => controller.providerConfig).toThrow(
            'Property only used for setting',
          );
        });
      });
    });

    describe('set', () => {
      ['1', '3', '4', '5', '42', ''].forEach((chainId) => {
        describe(`when the provider config in state contains a chain ID of "${chainId}"`, () => {
          it('sets isCustomNetwork in state to false', async () => {
            await withController(
              {
                state: {
                  isCustomNetwork: true,
                  providerConfig: buildProviderConfig({
                    chainId,
                  }),
                },
                infuraProjectId: 'infura-project-id',
              },
              ({ controller }) => {
                const fakeInfuraProvider = buildFakeInfuraProvider();
                createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
                const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
                SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
                const fakeMetamaskProvider = buildFakeMetamaskProvider();
                createMetamaskProviderMock.mockReturnValue(
                  fakeMetamaskProvider,
                );

                controller.providerConfig = buildProviderConfig();

                expect(controller.state.isCustomNetwork).toBe(false);
              },
            );
          });
        });
      });

      describe('when the provider config in state contains a chain ID that is not 1, 3, 4, 5, 42, or an empty string', () => {
        it('sets isCustomNetwork in state to true', async () => {
          await withController(
            {
              state: {
                providerConfig: buildProviderConfig({
                  chainId: '999',
                }),
              },
              infuraProjectId: 'infura-project-id',
            },
            ({ controller }) => {
              const fakeInfuraProvider = buildFakeInfuraProvider();
              createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
              const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
              SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
              const fakeMetamaskProvider = buildFakeMetamaskProvider();
              createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);

              controller.providerConfig = buildProviderConfig();

              expect(controller.state.isCustomNetwork).toBe(true);
            },
          );
        });
      });

      (['kovan', 'mainnet', 'rinkeby', 'goerli', 'ropsten'] as const).forEach(
        (networkType) => {
          describe(`when the provider config in state contains a network type of "${networkType}"`, () => {
            it(`sets the provider to an Infura provider pointed to ${networkType}`, async () => {
              await withController(
                {
                  state: {
                    providerConfig: buildProviderConfig({
                      type: networkType,
                    }),
                  },
                  infuraProjectId: 'infura-project-id',
                },
                ({ controller }) => {
                  const fakeInfuraProvider = buildFakeInfuraProvider();
                  createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
                  const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
                  SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
                  const fakeMetamaskProvider = buildFakeMetamaskProvider();
                  createMetamaskProviderMock.mockReturnValue(
                    fakeMetamaskProvider,
                  );

                  controller.providerConfig = {
                    // NOTE: Neither the type nor chainId needs to match the
                    // values in state, or match each other
                    type: 'mainnet',
                    chainId: '99999',
                    nickname: 'some nickname',
                  };

                  expect(createInfuraProviderMock).toHaveBeenCalledWith({
                    network: networkType,
                    projectId: 'infura-project-id',
                  });
                  expect(createMetamaskProviderMock).toHaveBeenCalledWith({
                    type: 'mainnet',
                    chainId: '99999',
                    nickname: 'some nickname',
                    dataSubprovider: fakeInfuraSubprovider,
                    engineParams: {
                      blockTrackerProvider: fakeInfuraProvider,
                      pollingInterval: 12000,
                    },
                  });
                  expect(controller.provider).toBe(fakeMetamaskProvider);
                },
              );
            });

            it('stops an existing provider eventually', async () => {
              await withController(
                {
                  state: {
                    providerConfig: buildProviderConfig({
                      type: networkType,
                    }),
                  },
                  infuraProjectId: 'infura-project-id',
                },
                ({ controller }) => {
                  const fakeInfuraProvider = buildFakeInfuraProvider();
                  createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
                  const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
                  SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
                  const fakeMetamaskProvider = buildFakeMetamaskProvider();
                  createMetamaskProviderMock.mockReturnValue(
                    fakeMetamaskProvider,
                  );
                  jest.spyOn(fakeMetamaskProvider, 'stop');

                  controller.providerConfig = buildProviderConfig();
                  controller.providerConfig = buildProviderConfig();
                  assert(controller.provider);
                  jest.runAllTimers();

                  expect(controller.provider.stop).toHaveBeenCalled();
                },
              );
            });

            describe('when an "error" event occurs on the new provider', () => {
              describe('when the network has not been connected to yet', () => {
                it('retrieves the network version twice more (due to the "error" event being listened to twice) and, assuming success, persists them to state', async () => {
                  const messenger = buildMessenger();
                  await withController(
                    {
                      messenger,
                      state: {
                        providerConfig: buildProviderConfig({
                          type: networkType,
                        }),
                      },
                      infuraProjectId: 'infura-project-id',
                    },
                    async ({ controller }) => {
                      const fakeInfuraProvider = buildFakeInfuraProvider();
                      createInfuraProviderMock.mockReturnValue(
                        fakeInfuraProvider,
                      );
                      const fakeInfuraSubprovider =
                        buildFakeInfuraSubprovider();
                      SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
                      const fakeMetamaskProvider = buildFakeMetamaskProvider([
                        {
                          request: {
                            method: 'net_version',
                          },
                          response: {
                            result: '1',
                          },
                        },
                        {
                          request: {
                            method: 'net_version',
                          },
                          response: {
                            result: '2',
                          },
                        },
                        {
                          request: {
                            method: 'net_version',
                          },
                          response: {
                            result: '3',
                          },
                        },
                      ]);
                      createMetamaskProviderMock.mockReturnValue(
                        fakeMetamaskProvider,
                      );
                      const promiseForNetworkChanges = new Promise<void>(
                        (resolve) => {
                          const newStates: NetworkState[] = [];
                          messenger.subscribe(
                            'NetworkController:stateChange',
                            (newState, patches) => {
                              if (didPropertyChange(patches, ['network'])) {
                                newStates.push(newState);

                                if (newStates.length === 3) {
                                  resolve();
                                }
                              }
                            },
                          );
                        },
                      );

                      controller.providerConfig = buildProviderConfig();
                      assert(controller.provider);
                      controller.provider.emit('error', { some: 'error' });

                      await promiseForNetworkChanges;
                      expect(controller.state.network).toBe('3');
                    },
                  );
                });
              });

              describe('if the network version could be retrieved after using the providerConfig setter', () => {
                it('does not retrieve the network version again', async () => {
                  const messenger = buildMessenger();
                  await withController(
                    {
                      messenger,
                      state: {
                        providerConfig: buildProviderConfig({
                          type: networkType,
                        }),
                      },
                      infuraProjectId: 'infura-project-id',
                    },
                    async ({ controller }) => {
                      const fakeInfuraProvider = buildFakeInfuraProvider();
                      createInfuraProviderMock.mockReturnValue(
                        fakeInfuraProvider,
                      );
                      const fakeInfuraSubprovider =
                        buildFakeInfuraSubprovider();
                      SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
                      const fakeMetamaskProvider = buildFakeMetamaskProvider([
                        {
                          request: {
                            method: 'net_version',
                          },
                          response: {
                            result: '1',
                          },
                        },
                        {
                          request: {
                            method: 'net_version',
                          },
                          response: {
                            result: '2',
                          },
                        },
                      ]);
                      createMetamaskProviderMock.mockReturnValue(
                        fakeMetamaskProvider,
                      );
                      const promiseForAllNetworkChanges =
                        await waitForAllStateChanges(messenger, ['network']);

                      controller.providerConfig = buildProviderConfig();
                      assert(controller.provider);
                      controller.provider.emit('error', { some: 'error' });

                      await promiseForAllNetworkChanges;
                      expect(controller.state.network).toBe('1');
                    },
                  );
                });
              });
            });
          });
        },
      );

      describe(`when the provider config in state contains a network type of "localhost"`, () => {
        it('sets the provider to a custom RPC provider pointed to localhost and initialized with the configured chain ID, nickname, and ticker', async () => {
          await withController(
            {
              state: {
                providerConfig: buildProviderConfig({
                  type: 'localhost',
                  chainId: '66666',
                  nickname: "doesn't matter",
                  rpcTarget: 'http://doesntmatter.com',
                  ticker: 'ABC',
                }),
              },
            },
            ({ controller }) => {
              const fakeMetamaskProvider = buildFakeMetamaskProvider();
              createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);

              controller.providerConfig = buildProviderConfig({
                // NOTE: The type does not need to match the type in state
                type: 'mainnet',
              });

              expect(createMetamaskProviderMock).toHaveBeenCalledWith({
                type: 'mainnet',
                chainId: undefined,
                engineParams: { pollingInterval: 12000 },
                nickname: undefined,
                rpcUrl: 'http://localhost:8545',
                ticker: undefined,
              });
              expect(controller.provider).toBe(fakeMetamaskProvider);
            },
          );
        });

        it('stops an existing provider eventually', async () => {
          await withController(
            {
              state: {
                providerConfig: buildProviderConfig({
                  type: 'localhost',
                }),
              },
            },
            ({ controller }) => {
              const fakeMetamaskProvider = buildFakeMetamaskProvider();
              createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
              jest.spyOn(fakeMetamaskProvider, 'stop');

              controller.providerConfig = buildProviderConfig();
              controller.providerConfig = buildProviderConfig();
              assert(controller.provider);
              jest.runAllTimers();

              expect(controller.provider.stop).toHaveBeenCalled();
            },
          );
        });

        describe('when an "error" event occurs on the new provider', () => {
          describe('when the network has not been connected to yet', () => {
            it('retrieves the network version twice more (due to the "error" event being listened to twice) and, assuming success, persists them to state', async () => {
              const messenger = buildMessenger();
              await withController(
                {
                  messenger,
                  state: {
                    providerConfig: buildProviderConfig({
                      type: 'localhost',
                    }),
                  },
                },
                async ({ controller }) => {
                  const fakeMetamaskProvider = buildFakeMetamaskProvider([
                    {
                      request: {
                        method: 'net_version',
                      },
                      response: {
                        result: '1',
                      },
                    },
                    {
                      request: {
                        method: 'net_version',
                      },
                      response: {
                        result: '2',
                      },
                    },
                    {
                      request: {
                        method: 'net_version',
                      },
                      response: {
                        result: '3',
                      },
                    },
                  ]);
                  createMetamaskProviderMock.mockReturnValue(
                    fakeMetamaskProvider,
                  );
                  const promiseForNetworkChanges = new Promise<void>(
                    (resolve) => {
                      const newStates: NetworkState[] = [];
                      messenger.subscribe(
                        'NetworkController:stateChange',
                        (newState, patches) => {
                          if (didPropertyChange(patches, ['network'])) {
                            newStates.push(newState);

                            if (newStates.length === 3) {
                              resolve();
                            }
                          }
                        },
                      );
                    },
                  );

                  controller.providerConfig = buildProviderConfig();
                  assert(controller.provider);
                  controller.provider.emit('error', { some: 'error' });

                  await promiseForNetworkChanges;
                  expect(controller.state.network).toBe('3');
                },
              );
            });
          });

          describe('if the network version could be retrieved after using the providerConfig setter', () => {
            it('does not retrieve the network version again', async () => {
              const messenger = buildMessenger();
              await withController(
                {
                  messenger,
                  state: {
                    providerConfig: buildProviderConfig({
                      type: 'localhost',
                    }),
                  },
                },
                async ({ controller }) => {
                  const fakeMetamaskProvider = buildFakeMetamaskProvider([
                    {
                      request: {
                        method: 'net_version',
                      },
                      response: {
                        result: '1',
                      },
                    },
                    {
                      request: {
                        method: 'net_version',
                      },
                      response: {
                        result: '2',
                      },
                    },
                  ]);
                  createMetamaskProviderMock.mockReturnValue(
                    fakeMetamaskProvider,
                  );
                  const promiseForAllNetworkChanges =
                    await waitForAllStateChanges(messenger, ['network']);

                  controller.providerConfig = buildProviderConfig();
                  assert(controller.provider);
                  controller.provider.emit('error', { some: 'error' });

                  await promiseForAllNetworkChanges;
                  expect(controller.state.network).toBe('1');
                },
              );
            });
          });
        });
      });

      describe('when the provider config in state contains a network type of "rpc"', () => {
        describe('if the provider config contains an RPC target', () => {
          it('sets the provider to a custom RPC provider initialized with the configured target, chain ID, nickname, and ticker', async () => {
            await withController(
              {
                state: {
                  providerConfig: {
                    type: 'rpc',
                    chainId: '123',
                    nickname: 'some cool network',
                    rpcTarget: 'http://example.com',
                    ticker: 'ABC',
                  },
                },
              },
              ({ controller }) => {
                const fakeMetamaskProvider = buildFakeMetamaskProvider();
                createMetamaskProviderMock.mockReturnValue(
                  fakeMetamaskProvider,
                );

                controller.providerConfig = buildProviderConfig({
                  // NOTE: The type does not need to match the type in state
                  type: 'mainnet',
                });

                expect(createMetamaskProviderMock).toHaveBeenCalledWith({
                  type: 'mainnet',
                  chainId: '123',
                  engineParams: { pollingInterval: 12000 },
                  nickname: 'some cool network',
                  rpcUrl: 'http://example.com',
                  ticker: 'ABC',
                });
                expect(controller.provider).toBe(fakeMetamaskProvider);
              },
            );
          });

          it('updates properties.isEIP1559Compatible in state based on the latest block (assuming that the request to eth_getBlockByNumber is made successfully)', async () => {
            const messenger = buildMessenger();
            await withController(
              {
                messenger,
                state: {
                  properties: {
                    isEIP1559Compatible: false,
                  },
                  providerConfig: buildProviderConfig({
                    type: 'rpc',
                    rpcTarget: 'http://example.com',
                  }),
                },
              },
              async ({ controller }) => {
                const fakeMetamaskProvider = buildFakeMetamaskProvider([
                  {
                    request: {
                      method: 'eth_getBlockByNumber',
                      params: ['latest', false],
                    },
                    response: {
                      result: {
                        baseFeePerGas: '0x1',
                      },
                    },
                  },
                ]);
                createMetamaskProviderMock.mockReturnValue(
                  fakeMetamaskProvider,
                );
                const promiseForIsEIP1559CompatibleChange =
                  new Promise<NetworkState>((resolve) => {
                    messenger.subscribe(
                      'NetworkController:stateChange',
                      (newState, patches) => {
                        if (
                          didPropertyChange(patches, [
                            'properties',
                            'isEIP1559Compatible',
                          ])
                        ) {
                          resolve(newState);
                        }
                      },
                    );
                  });

                controller.providerConfig = buildProviderConfig();

                await promiseForIsEIP1559CompatibleChange;
                expect(controller.state.properties.isEIP1559Compatible).toBe(
                  true,
                );
              },
            );
          });

          it('stops an existing provider eventually', async () => {
            await withController(
              {
                state: {
                  providerConfig: buildProviderConfig({
                    type: 'rpc',
                    rpcTarget: 'http://example.com',
                  }),
                },
              },
              ({ controller }) => {
                const fakeMetamaskProvider = buildFakeMetamaskProvider();
                createMetamaskProviderMock.mockReturnValue(
                  fakeMetamaskProvider,
                );
                jest.spyOn(fakeMetamaskProvider, 'stop');

                controller.providerConfig = buildProviderConfig();
                controller.providerConfig = buildProviderConfig();
                jest.runAllTimers();

                assert(controller.provider);
                expect(controller.provider.stop).toHaveBeenCalled();
              },
            );
          });

          describe('when an "error" event occurs on the new provider', () => {
            describe('when the network has not been connected to yet', () => {
              it('retrieves the network version twice more (due to the "error" event being listened to twice) and, assuming success, persists them to state', async () => {
                const messenger = buildMessenger();
                await withController(
                  {
                    messenger,
                    state: {
                      providerConfig: buildProviderConfig({
                        type: 'rpc',
                        rpcTarget: 'http://example.com',
                      }),
                    },
                  },
                  async ({ controller }) => {
                    const fakeMetamaskProvider = buildFakeMetamaskProvider([
                      {
                        request: {
                          method: 'net_version',
                        },
                        response: {
                          result: '1',
                        },
                      },
                      {
                        request: {
                          method: 'net_version',
                        },
                        response: {
                          result: '2',
                        },
                      },
                      {
                        request: {
                          method: 'net_version',
                        },
                        response: {
                          result: '3',
                        },
                      },
                    ]);
                    createMetamaskProviderMock.mockReturnValue(
                      fakeMetamaskProvider,
                    );
                    const promiseForNetworkChanges = new Promise<void>(
                      (resolve) => {
                        const newStates: NetworkState[] = [];
                        messenger.subscribe(
                          'NetworkController:stateChange',
                          (newState, patches) => {
                            if (didPropertyChange(patches, ['network'])) {
                              newStates.push(newState);

                              if (newStates.length === 3) {
                                resolve();
                              }
                            }
                          },
                        );
                      },
                    );

                    controller.providerConfig = buildProviderConfig();
                    assert(controller.provider);
                    controller.provider.emit('error', { some: 'error' });

                    await promiseForNetworkChanges;
                    expect(controller.state.network).toBe('3');
                  },
                );
              });
            });

            describe('if the network version could be retrieved after using the providerConfig setter', () => {
              it('does not retrieve the network version again', async () => {
                const messenger = buildMessenger();
                await withController(
                  {
                    messenger,
                    state: {
                      providerConfig: buildProviderConfig({
                        type: 'rpc',
                        rpcTarget: 'http://example.com',
                      }),
                    },
                  },
                  async ({ controller }) => {
                    const fakeMetamaskProvider = buildFakeMetamaskProvider([
                      {
                        request: {
                          method: 'net_version',
                        },
                        response: {
                          result: '1',
                        },
                      },
                      {
                        request: {
                          method: 'net_version',
                        },
                        response: {
                          result: '2',
                        },
                      },
                    ]);
                    createMetamaskProviderMock.mockReturnValue(
                      fakeMetamaskProvider,
                    );
                    const promiseForAllNetworkChanges =
                      await waitForAllStateChanges(messenger, ['network']);

                    controller.providerConfig = buildProviderConfig();
                    assert(controller.provider);
                    controller.provider.emit('error', { some: 'error' });

                    await promiseForAllNetworkChanges;
                    expect(controller.state.network).toBe('1');
                  },
                );
              });
            });
          });
        });

        describe('if the RPC target is not set', () => {
          it('does not set the provider', async () => {
            await withController(
              {
                state: {
                  providerConfig: buildProviderConfig({
                    type: 'rpc',
                  }),
                },
              },
              ({ controller }) => {
                const fakeMetamaskProvider = buildFakeMetamaskProvider();
                createMetamaskProviderMock.mockReturnValue(
                  fakeMetamaskProvider,
                );

                controller.providerConfig = buildProviderConfig();

                expect(createMetamaskProviderMock).not.toHaveBeenCalled();
                expect(controller.provider).toBeUndefined();
              },
            );
          });
        });
      });

      it('updates properties.isEIP1559Compatible in state based on the latest block (assuming that the request to eth_getBlockByNumber is made successfully)', async () => {
        const messenger = buildMessenger();
        await withController(
          {
            messenger,
            state: {
              providerConfig: buildProviderConfig(),
            },
          },
          async ({ controller }) => {
            const fakeMetamaskProvider = buildFakeMetamaskProvider([
              {
                request: {
                  method: 'eth_getBlockByNumber',
                  params: ['latest', false],
                },
                response: {
                  result: {
                    baseFeePerGas: '0x1',
                  },
                },
              },
            ]);
            createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
            const promiseForIsEIP1559CompatibleChange =
              new Promise<NetworkState>((resolve) => {
                messenger.subscribe(
                  'NetworkController:stateChange',
                  (newState, patches) => {
                    if (
                      didPropertyChange(patches, [
                        'properties',
                        'isEIP1559Compatible',
                      ])
                    ) {
                      resolve(newState);
                    }
                  },
                );
              });

            controller.providerConfig = buildProviderConfig();

            await promiseForIsEIP1559CompatibleChange;
            expect(controller.state.properties.isEIP1559Compatible).toBe(true);
          },
        );
      });
    });
  });

  describe('lookupNetwork', () => {
    describe('if a provider has not been set', () => {
      it('makes no state changes', async () => {
        const messenger = buildMessenger();
        await withController({ messenger }, async ({ controller }) => {
          const promiseForStateChange = new Promise<void>((resolve) => {
            messenger.subscribe('NetworkController:stateChange', () => {
              resolve();
            });
          });

          await controller.lookupNetwork();

          await expect(promiseForStateChange).toNeverResolve();
        });
      });

      it('does not publish NetworkController:providerConfigChange', async () => {
        const messenger = buildMessenger();
        await withController({ messenger }, async ({ controller }) => {
          const promiseForProviderConfigChange = new Promise<void>(
            (resolve) => {
              messenger.subscribe(
                'NetworkController:providerConfigChange',
                () => {
                  resolve();
                },
              );
            },
          );

          await controller.lookupNetwork();

          await expect(promiseForProviderConfigChange).toNeverResolve();
        });
      });
    });

    describe('if a provider has been set, but the resulting EthQuery object does not have a sendAsync method', () => {
      it('makes no state changes', async () => {
        const messenger = buildMessenger();
        await withController({ messenger }, async ({ controller }) => {
          const fakeEthQuery = {};
          jest.spyOn(ethQueryModule, 'default').mockReturnValue(fakeEthQuery);
          await setFakeProvider(controller, {
            stubLookupNetworkWhileSetting: true,
          });
          const promiseForStateChange = new Promise<void>((resolve) => {
            messenger.subscribe('NetworkController:stateChange', () => {
              resolve();
            });
          });

          await controller.lookupNetwork();

          await expect(promiseForStateChange).toNeverResolve();
        });
      });

      it('does not publish NetworkController:providerConfigChange', async () => {
        const messenger = buildMessenger();
        await withController({ messenger }, async ({ controller }) => {
          const fakeEthQuery = {};
          jest.spyOn(ethQueryModule, 'default').mockReturnValue(fakeEthQuery);
          await setFakeProvider(controller, {
            stubLookupNetworkWhileSetting: true,
          });
          const promiseForProviderConfigChange = new Promise<void>(
            (resolve) => {
              messenger.subscribe(
                'NetworkController:providerConfigChange',
                () => {
                  resolve();
                },
              );
            },
          );

          await controller.lookupNetwork();

          await expect(promiseForProviderConfigChange).toNeverResolve();
        });
      });
    });

    describe('if a provider has been set and the resulting EthQuery object has a sendAsync method', () => {
      describe('assuming that the version of the current network is different from the network in state', () => {
        it('updates the network in state to match', async () => {
          const messenger = buildMessenger();
          await withController(
            { messenger, state: { network: '' } },
            async ({ controller }) => {
              await setFakeProvider(controller, {
                stubs: [
                  {
                    request: { method: 'net_version' },
                    response: { result: '12345' },
                  },
                ],
                stubLookupNetworkWhileSetting: true,
              });
              const promiseForStateChange = new Promise<void>((resolve) => {
                messenger.subscribe('NetworkController:stateChange', () => {
                  resolve();
                });
              });

              await controller.lookupNetwork();

              await promiseForStateChange;
              expect(controller.state.network).toBe('12345');
            },
          );
        });

        it("publishes NetworkController:providerConfigChange with the current provider config (even though it didn't change)", async () => {
          const messenger = buildMessenger();
          await withController({ messenger }, async ({ controller }) => {
            await setFakeProvider(controller, {
              stubLookupNetworkWhileSetting: true,
            });
            await setFakeProvider(controller, {
              stubs: [
                {
                  request: { method: 'net_version' },
                  response: { result: '12345' },
                },
              ],
              stubLookupNetworkWhileSetting: true,
            });
            const promiseForProviderConfigChange = new Promise((resolve) => {
              messenger.subscribe(
                'NetworkController:providerConfigChange',
                () => {
                  resolve(true);
                },
              );
            });

            await controller.lookupNetwork();

            expect(await promiseForProviderConfigChange).toBe(true);
          });
        });
      });

      describe('if the version of the current network is the same as that in state', () => {
        it('makes no state changes', async () => {
          const messenger = buildMessenger();
          await withController(
            { messenger, state: { network: '12345' } },
            async ({ controller }) => {
              await setFakeProvider(controller, {
                stubs: [
                  {
                    request: { method: 'net_version' },
                    response: { result: '12345' },
                  },
                ],
                stubLookupNetworkWhileSetting: true,
              });
              const promiseForStateChange = new Promise<void>((resolve) => {
                messenger.subscribe('NetworkController:stateChange', () => {
                  resolve();
                });
              });

              await controller.lookupNetwork();

              await expect(promiseForStateChange).toNeverResolve();
            },
          );
        });

        it('does not publish NetworkController:providerConfigChange', async () => {
          const messenger = buildMessenger();
          await withController(
            { messenger, state: { network: '12345' } },
            async ({ controller }) => {
              await setFakeProvider(controller, {
                stubs: [
                  {
                    request: { method: 'net_version' },
                    response: { result: '12345' },
                  },
                ],
                stubLookupNetworkWhileSetting: true,
              });
              const promiseForProviderConfigChange = new Promise<void>(
                (resolve) => {
                  messenger.subscribe(
                    'NetworkController:providerConfigChange',
                    () => {
                      resolve();
                    },
                  );
                },
              );

              await controller.lookupNetwork();

              await expect(promiseForProviderConfigChange).toNeverResolve();
            },
          );
        });
      });

      describe('if an error is encountered while retrieving the version of the current network', () => {
        it('updates the network in state to "loading"', async () => {
          const messenger = buildMessenger();
          await withController(
            { messenger, state: { network: '1' } },
            async ({ controller }) => {
              await setFakeProvider(controller, {
                stubs: [
                  {
                    request: { method: 'net_version' },
                    response: { error: 'some error' },
                  },
                ],
                stubLookupNetworkWhileSetting: true,
              });
              const promiseForStateChange = new Promise<void>((resolve) => {
                messenger.subscribe('NetworkController:stateChange', () => {
                  resolve();
                });
              });

              await controller.lookupNetwork();

              await promiseForStateChange;
              expect(controller.state.network).toBe('loading');
            },
          );
        });

        it("publishes NetworkController:providerConfigChange with the current provider config (even though it didn't change)", async () => {
          const messenger = buildMessenger();
          await withController({ messenger }, async ({ controller }) => {
            await setFakeProvider(controller, {
              stubLookupNetworkWhileSetting: true,
            });
            await setFakeProvider(controller, {
              stubs: [
                {
                  request: { method: 'net_version' },
                  response: { error: 'some error' },
                },
              ],
              stubLookupNetworkWhileSetting: true,
            });
            const promiseForProviderConfigChange = new Promise((resolve) => {
              messenger.subscribe(
                'NetworkController:providerConfigChange',
                () => {
                  resolve(true);
                },
              );
            });

            await controller.lookupNetwork();

            expect(await promiseForProviderConfigChange).toBe(true);
          });
        });
      });

      describe('if lookupNetwork is called multiple times in quick succession', () => {
        it('waits until each call finishes before resolving the next', async () => {
          const messenger = buildMessenger();
          await withController({ messenger }, async ({ controller }) => {
            await setFakeProvider(controller, {
              stubs: [
                {
                  request: { method: 'net_version' },
                  response: { result: '1' },
                  delay: 100,
                },
                {
                  request: { method: 'net_version' },
                  response: { result: '2' },
                  delay: 0,
                },
                {
                  request: { method: 'net_version' },
                  response: { result: '3' },
                  delay: 200,
                },
              ],
              stubLookupNetworkWhileSetting: true,
            });
            const promiseForNewStates = new Promise<NetworkState[]>(
              (resolve) => {
                const newStates: NetworkState[] = [];
                messenger.subscribe(
                  'NetworkController:stateChange',
                  (newState) => {
                    newStates.push(newState);
                    if (newStates.length === 3) {
                      resolve(newStates);
                    }
                  },
                );
              },
            );

            await Promise.all([
              controller.lookupNetwork(),
              controller.lookupNetwork(),
              controller.lookupNetwork(),
            ]);

            expect(await promiseForNewStates).toMatchObject([
              expect.objectContaining({ network: '1' }),
              expect.objectContaining({ network: '2' }),
              expect.objectContaining({ network: '3' }),
            ]);
          });
        });
      });
    });
  });

  describe('setProviderType', () => {
    describe('given a network type of "mainnet"', () => {
      it('updates the provider config in state with the network type and the corresponding chain ID, using "ETH" for the ticker and clearing any existing RPC target and nickname', async () => {
        const messenger = buildMessenger();
        await withController(
          {
            messenger,
            state: {
              providerConfig: {
                type: 'localhost',
                rpcTarget: 'http://somethingexisting.com',
                chainId: '99999',
                ticker: 'something existing',
                nickname: 'something existing',
              },
            },
          },
          async ({ controller }) => {
            const fakeInfuraProvider = buildFakeInfuraProvider();
            createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
            const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
            SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
            const fakeMetamaskProvider = buildFakeMetamaskProvider();
            createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
            const promiseForStateChange = new Promise<void>((resolve) => {
              messenger.subscribe('NetworkController:stateChange', () => {
                resolve();
              });
            });

            controller.setProviderType('mainnet' as const);

            await promiseForStateChange;
            expect(controller.state.providerConfig).toStrictEqual({
              type: 'mainnet',
              ticker: 'ETH',
              chainId: '1',
              rpcTarget: undefined,
              nickname: undefined,
            });
          },
        );
      });

      it('sets isCustomNetwork in state to false', async () => {
        const messenger = buildMessenger();
        await withController(
          {
            messenger,
            state: {
              isCustomNetwork: true,
            },
            infuraProjectId: 'infura-project-id',
          },
          async ({ controller }) => {
            const fakeInfuraProvider = buildFakeInfuraProvider();
            createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
            const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
            SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
            const fakeMetamaskProvider = buildFakeMetamaskProvider();
            createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
            const promiseForIsCustomNetworkChange = new Promise<void>(
              (resolve) => {
                messenger.subscribe(
                  'NetworkController:stateChange',
                  (_, patches) => {
                    if (didPropertyChange(patches, ['isCustomNetwork'])) {
                      resolve();
                    }
                  },
                );
              },
            );

            controller.setProviderType('mainnet' as const);

            await promiseForIsCustomNetworkChange;
            expect(controller.state.isCustomNetwork).toBe(false);
          },
        );
      });

      it('sets the provider to an Infura provider pointed to Mainnet', async () => {
        await withController(
          {
            infuraProjectId: 'infura-project-id',
          },
          ({ controller }) => {
            const fakeInfuraProvider = buildFakeInfuraProvider();
            createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
            const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
            SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
            const fakeMetamaskProvider = buildFakeMetamaskProvider();
            createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);

            controller.setProviderType('mainnet' as const);

            expect(createInfuraProviderMock).toHaveBeenCalledWith({
              network: 'mainnet',
              projectId: 'infura-project-id',
            });
            expect(createMetamaskProviderMock).toHaveBeenCalledWith({
              dataSubprovider: fakeInfuraSubprovider,
              engineParams: {
                blockTrackerProvider: fakeInfuraProvider,
                pollingInterval: 12000,
              },
            });
            expect(controller.provider).toBe(fakeMetamaskProvider);
          },
        );
      });

      it('updates properties.isEIP1559Compatible in state based on the latest block (assuming that the request to eth_getBlockByNumber is made successfully)', async () => {
        const messenger = buildMessenger();
        await withController(
          {
            messenger,
          },
          async ({ controller }) => {
            const fakeInfuraProvider = buildFakeInfuraProvider();
            createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
            const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
            SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
            const fakeMetamaskProvider = buildFakeMetamaskProvider([
              {
                request: {
                  method: 'eth_getBlockByNumber',
                  params: ['latest', false],
                },
                response: {
                  result: {
                    baseFeePerGas: '0x1',
                  },
                },
              },
            ]);
            createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
            const promiseForIsEIP1559CompatibleChange =
              new Promise<NetworkState>((resolve) => {
                messenger.subscribe(
                  'NetworkController:stateChange',
                  (newState, patches) => {
                    if (
                      didPropertyChange(patches, [
                        'properties',
                        'isEIP1559Compatible',
                      ])
                    ) {
                      resolve(newState);
                    }
                  },
                );
              });

            controller.setProviderType('mainnet' as const);

            await promiseForIsEIP1559CompatibleChange;
            expect(controller.state.properties.isEIP1559Compatible).toBe(true);
          },
        );
      });

      it('stops an existing provider eventually', async () => {
        await withController(({ controller }) => {
          const fakeInfuraProvider = buildFakeInfuraProvider();
          createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
          const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
          SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
          const fakeMetamaskProvider = buildFakeMetamaskProvider();
          createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
          jest.spyOn(fakeMetamaskProvider, 'stop');

          controller.setProviderType('mainnet' as const);
          controller.setProviderType('mainnet' as const);
          assert(controller.provider);
          jest.runAllTimers();

          expect(controller.provider.stop).toHaveBeenCalled();
        });
      });

      it('records the version of the current network in state (assuming that the request to net_version is made successfully)', async () => {
        const messenger = buildMessenger();
        await withController({ messenger }, async ({ controller }) => {
          const fakeInfuraProvider = buildFakeInfuraProvider();
          createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
          const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
          SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
          const fakeMetamaskProvider = buildFakeMetamaskProvider([
            {
              request: {
                method: 'net_version',
                params: [],
              },
              response: {
                result: '42',
              },
            },
          ]);
          createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
          const promiseForNetworkChange = new Promise<NetworkState>(
            (resolve) => {
              messenger.subscribe(
                'NetworkController:stateChange',
                (newState, patches) => {
                  if (didPropertyChange(patches, ['network'])) {
                    resolve(newState);
                  }
                },
              );
            },
          );

          controller.setProviderType('mainnet' as const);

          await promiseForNetworkChange;
          expect(controller.state.network).toBe('42');
        });
      });

      describe('when an "error" event occurs on the new provider', () => {
        describe('if the network version could not be retrieved during setProviderType', () => {
          it('retrieves the network version again and, assuming success, persists it to state', async () => {
            const messenger = buildMessenger();
            await withController({ messenger }, async ({ controller }) => {
              const fakeInfuraProvider = buildFakeInfuraProvider();
              createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
              const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
              SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
              const fakeMetamaskProvider = buildFakeMetamaskProvider([
                {
                  request: {
                    method: 'net_version',
                  },
                  response: {
                    error: 'oops',
                  },
                },
                {
                  request: {
                    method: 'net_version',
                  },
                  response: {
                    result: '42',
                  },
                },
              ]);
              createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
              const promiseForNetworkChange = new Promise<void>((resolve) => {
                messenger.subscribe(
                  'NetworkController:stateChange',
                  (_, patches) => {
                    if (didPropertyChange(patches, ['network'])) {
                      resolve();
                    }
                  },
                );
              });

              controller.setProviderType('mainnet' as const);
              assert(controller.provider);
              controller.provider.emit('error', { some: 'error' });

              await promiseForNetworkChange;
              expect(controller.state.network).toBe('42');
            });
          });
        });

        describe('if the network version could be retrieved during setProviderType', () => {
          it('does not retrieve the network version again', async () => {
            const messenger = buildMessenger();
            await withController({ messenger }, async ({ controller }) => {
              const fakeInfuraProvider = buildFakeInfuraProvider();
              createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
              const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
              SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
              const fakeMetamaskProvider = buildFakeMetamaskProvider([
                {
                  request: {
                    method: 'net_version',
                  },
                  response: {
                    result: '1',
                  },
                },
                {
                  request: {
                    method: 'net_version',
                  },
                  response: {
                    result: '2',
                  },
                },
              ]);
              createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);

              const promiseForFirstNetworkChange = waitForStateChange(
                messenger,
                ['network'],
              );
              controller.setProviderType('mainnet' as const);
              assert(controller.provider);
              await promiseForFirstNetworkChange;
              expect(controller.state.network).toBe('1');

              const promiseForNextNetworkChange = waitForStateChange(
                messenger,
                ['network'],
              );
              controller.provider.emit('error', { some: 'error' });
              await expect(promiseForNextNetworkChange).toNeverResolve();
            });
          });
        });
      });
    });

    (
      [
        {
          networkType: 'rinkeby',
          ticker: 'RinkebyETH',
          chainId: '4',
          networkName: 'Rinkeby',
        },
        {
          networkType: 'goerli',
          ticker: 'GoerliETH',
          chainId: '5',
          networkName: 'Goerli',
        },
        {
          networkType: 'ropsten',
          ticker: 'RopstenETH',
          chainId: '3',
          networkName: 'Ropsten',
        },
        {
          networkType: 'kovan',
          ticker: 'KovanETH',
          chainId: '42',
          networkName: 'Kovan',
        },
      ] as const
    ).forEach(({ networkType, ticker, chainId, networkName }) => {
      describe(`given a network type of "${networkType}"`, () => {
        it('updates the provider config in state with the network type, the corresponding chain ID, and a special ticker, clearing any existing RPC target and nickname', async () => {
          const messenger = buildMessenger();
          await withController(
            {
              messenger,
              state: {
                providerConfig: {
                  type: 'localhost',
                  rpcTarget: 'http://somethingexisting.com',
                  chainId: '99999',
                  ticker: 'something existing',
                  nickname: 'something existing',
                },
              },
            },
            async ({ controller }) => {
              const fakeInfuraProvider = buildFakeInfuraProvider();
              createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
              const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
              SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
              const fakeMetamaskProvider = buildFakeMetamaskProvider();
              createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
              const promiseForStateChange = new Promise<void>((resolve) => {
                messenger.subscribe('NetworkController:stateChange', () => {
                  resolve();
                });
              });

              controller.setProviderType(networkType);

              await promiseForStateChange;
              expect(controller.state.providerConfig).toStrictEqual({
                type: networkType,
                ticker,
                chainId,
                rpcTarget: undefined,
                nickname: undefined,
              });
            },
          );
        });

        it('sets isCustomNetwork in state to false', async () => {
          const messenger = buildMessenger();
          await withController(
            {
              messenger,
              state: {
                isCustomNetwork: true,
              },
            },
            async ({ controller }) => {
              const fakeInfuraProvider = buildFakeInfuraProvider();
              createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
              const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
              SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
              const fakeMetamaskProvider = buildFakeMetamaskProvider();
              createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
              const promiseForIsCustomNetworkChange = new Promise<void>(
                (resolve) => {
                  messenger.subscribe(
                    'NetworkController:stateChange',
                    (_, patches) => {
                      if (didPropertyChange(patches, ['isCustomNetwork'])) {
                        resolve();
                      }
                    },
                  );
                },
              );

              controller.setProviderType(networkType);

              await promiseForIsCustomNetworkChange;
              expect(controller.state.isCustomNetwork).toBe(false);
            },
          );
        });

        it(`sets the provider to an Infura provider pointed to ${networkName}`, async () => {
          await withController(
            {
              infuraProjectId: 'infura-project-id',
            },
            ({ controller }) => {
              const fakeInfuraProvider = buildFakeInfuraProvider();
              createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
              const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
              SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
              const fakeMetamaskProvider = buildFakeMetamaskProvider();
              createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);

              controller.setProviderType(networkType);

              expect(createInfuraProviderMock).toHaveBeenCalledWith({
                network: networkType,
                projectId: 'infura-project-id',
              });
              expect(createMetamaskProviderMock).toHaveBeenCalledWith({
                dataSubprovider: fakeInfuraSubprovider,
                engineParams: {
                  blockTrackerProvider: fakeInfuraProvider,
                  pollingInterval: 12000,
                },
              });
              expect(controller.provider).toBe(fakeMetamaskProvider);
            },
          );
        });

        it('updates properties.isEIP1559Compatible in state based on the latest block (assuming that the request to eth_getBlockByNumber is made successfully)', async () => {
          const messenger = buildMessenger();
          await withController(
            {
              messenger,
            },
            async ({ controller }) => {
              const fakeInfuraProvider = buildFakeInfuraProvider();
              createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
              const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
              SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
              const fakeMetamaskProvider = buildFakeMetamaskProvider([
                {
                  request: {
                    method: 'eth_getBlockByNumber',
                    params: ['latest', false],
                  },
                  response: {
                    result: {
                      baseFeePerGas: '0x1',
                    },
                  },
                },
              ]);
              createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
              const promiseForIsEIP1559CompatibleChange =
                new Promise<NetworkState>((resolve) => {
                  messenger.subscribe(
                    'NetworkController:stateChange',
                    (newState, patches) => {
                      if (
                        didPropertyChange(patches, [
                          'properties',
                          'isEIP1559Compatible',
                        ])
                      ) {
                        resolve(newState);
                      }
                    },
                  );
                });

              controller.setProviderType(networkType);

              await promiseForIsEIP1559CompatibleChange;
              expect(controller.state.properties.isEIP1559Compatible).toBe(
                true,
              );
            },
          );
        });

        it('stops an existing provider eventually', async () => {
          await withController(({ controller }) => {
            const fakeInfuraProvider = buildFakeInfuraProvider();
            createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
            const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
            SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
            const fakeMetamaskProvider = buildFakeMetamaskProvider();
            createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
            jest.spyOn(fakeMetamaskProvider, 'stop');

            controller.setProviderType('rinkeby' as const);
            controller.setProviderType('rinkeby' as const);
            assert(controller.provider);
            jest.runAllTimers();

            expect(controller.provider.stop).toHaveBeenCalled();
          });
        });

        it('updates the version of the current network in state (assuming that the request to net_version is made successfully)', async () => {
          const messenger = buildMessenger();
          await withController({ messenger }, async ({ controller }) => {
            const fakeInfuraProvider = buildFakeInfuraProvider();
            createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
            const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
            SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
            const fakeMetamaskProvider = buildFakeMetamaskProvider([
              {
                request: {
                  method: 'net_version',
                  params: [],
                },
                response: {
                  result: '42',
                },
              },
            ]);
            createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
            const promiseForNetworkChange = new Promise<NetworkState>(
              (resolve) => {
                messenger.subscribe(
                  'NetworkController:stateChange',
                  (newState, patches) => {
                    if (didPropertyChange(patches, ['network'])) {
                      resolve(newState);
                    }
                  },
                );
              },
            );

            controller.setProviderType(networkType);

            await promiseForNetworkChange;
            expect(controller.state.network).toBe('42');
          });
        });

        describe('when an "error" event occurs on the new provider', () => {
          describe('if the network version could not be retrieved during setProviderType', () => {
            it('retrieves the network version again and, assuming success, persists it to state', async () => {
              const messenger = buildMessenger();
              await withController({ messenger }, async ({ controller }) => {
                const fakeInfuraProvider = buildFakeInfuraProvider();
                createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
                const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
                SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
                const fakeMetamaskProvider = buildFakeMetamaskProvider([
                  {
                    request: {
                      method: 'net_version',
                    },
                    response: {
                      error: 'oops',
                    },
                  },
                  {
                    request: {
                      method: 'net_version',
                    },
                    response: {
                      result: '42',
                    },
                  },
                ]);
                createMetamaskProviderMock.mockReturnValue(
                  fakeMetamaskProvider,
                );
                const promiseForNetworkChange = new Promise<void>((resolve) => {
                  messenger.subscribe(
                    'NetworkController:stateChange',
                    (_, patches) => {
                      if (didPropertyChange(patches, ['network'])) {
                        resolve();
                      }
                    },
                  );
                });

                controller.setProviderType(networkType);
                assert(controller.provider);
                controller.provider.emit('error', { some: 'error' });

                await promiseForNetworkChange;
                expect(controller.state.network).toBe('42');
              });
            });
          });

          describe('if the network version could be retrieved during setProviderType', () => {
            it('does not retrieve the network version again', async () => {
              const messenger = buildMessenger();
              await withController({ messenger }, async ({ controller }) => {
                const fakeInfuraProvider = buildFakeInfuraProvider();
                createInfuraProviderMock.mockReturnValue(fakeInfuraProvider);
                const fakeInfuraSubprovider = buildFakeInfuraSubprovider();
                SubproviderMock.mockReturnValue(fakeInfuraSubprovider);
                const fakeMetamaskProvider = buildFakeMetamaskProvider([
                  {
                    request: {
                      method: 'net_version',
                    },
                    response: {
                      result: '1',
                    },
                  },
                  {
                    request: {
                      method: 'net_version',
                    },
                    response: {
                      result: '2',
                    },
                  },
                ]);
                createMetamaskProviderMock.mockReturnValue(
                  fakeMetamaskProvider,
                );

                const promiseForFirstNetworkChange = waitForStateChange(
                  messenger,
                  ['network'],
                );
                controller.setProviderType(networkType);
                assert(controller.provider);
                await promiseForFirstNetworkChange;

                const promiseForNextNetworkChange = waitForStateChange(
                  messenger,
                  ['network'],
                );
                controller.provider.emit('error', { some: 'error' });
                await expect(promiseForNextNetworkChange).toNeverResolve();
              });
            });
          });
        });
      });
    });

    describe('given a network type of "rpc"', () => {
      it('updates the provider config in state with the network type, using "ETH" for the ticker and an empty string for the chain id and clearing any existing RPC target and nickname', async () => {
        const messenger = buildMessenger();
        await withController(
          {
            messenger,
            state: {
              providerConfig: {
                type: 'localhost',
                rpcTarget: 'http://somethingexisting.com',
                chainId: '99999',
                ticker: 'something existing',
                nickname: 'something existing',
              },
            },
          },
          async ({ controller }) => {
            const fakeMetamaskProvider = buildFakeMetamaskProvider();
            createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
            const promiseForStateChange = new Promise<void>((resolve) => {
              messenger.subscribe('NetworkController:stateChange', () => {
                resolve();
              });
            });

            controller.setProviderType('rpc' as const);

            await promiseForStateChange;
            expect(controller.state.providerConfig).toStrictEqual({
              type: 'rpc',
              ticker: 'ETH',
              chainId: '',
              rpcTarget: undefined,
              nickname: undefined,
            });
          },
        );
      });

      it('does not set isCustomNetwork in state to false (because the chain ID is cleared)', async () => {
        const messenger = buildMessenger();
        await withController(
          {
            messenger,
            state: {
              isCustomNetwork: false,
            },
            infuraProjectId: 'infura-project-id',
          },
          async ({ controller }) => {
            const fakeMetamaskProvider = buildFakeMetamaskProvider();
            createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
            const promiseForIsCustomNetworkChange = new Promise<void>(
              (resolve) => {
                messenger.subscribe(
                  'NetworkController:stateChange',
                  (_, patches) => {
                    if (didPropertyChange(patches, ['isCustomNetwork'])) {
                      resolve();
                    }
                  },
                );
              },
            );

            controller.setProviderType('rpc' as const);

            await expect(promiseForIsCustomNetworkChange).toNeverResolve();
          },
        );
      });

      it("doesn't set a provider (because the RPC target is cleared)", async () => {
        await withController(({ controller }) => {
          const fakeMetamaskProvider = buildFakeMetamaskProvider();
          createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);

          controller.setProviderType('rpc' as const);

          expect(createMetamaskProviderMock).not.toHaveBeenCalled();
          expect(controller.provider).toBeUndefined();
        });
      });

      it('does not update properties.isEIP1559Compatible in state based on the latest block (because the RPC target is cleared)', async () => {
        const messenger = buildMessenger();
        await withController(
          {
            messenger,
          },
          async ({ controller }) => {
            const fakeMetamaskProvider = buildFakeMetamaskProvider([
              {
                request: {
                  method: 'eth_getBlockByNumber',
                  params: ['latest', false],
                },
                response: {
                  result: {
                    baseFeePerGas: '0x1',
                  },
                },
              },
            ]);
            createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
            const promiseForIsEIP1559CompatibleChange =
              new Promise<NetworkState>((resolve) => {
                messenger.subscribe(
                  'NetworkController:stateChange',
                  (newState, patches) => {
                    if (
                      didPropertyChange(patches, [
                        'properties',
                        'isEIP1559Compatible',
                      ])
                    ) {
                      resolve(newState);
                    }
                  },
                );
              });

            controller.setProviderType('rpc' as const);

            await promiseForIsEIP1559CompatibleChange;
            expect(
              controller.state.properties.isEIP1559Compatible,
            ).toBeUndefined();
          },
        );
      });
    });

    describe('given a network type of "localhost"', () => {
      it('updates the provider config in state with the network type, using "ETH" for the ticker and an empty string for the chain id and clearing any existing RPC target and nickname', async () => {
        const messenger = buildMessenger();
        await withController(
          {
            messenger,
            state: {
              providerConfig: {
                type: 'localhost',
                rpcTarget: 'http://somethingexisting.com',
                chainId: '99999',
                ticker: 'something existing',
                nickname: 'something existing',
              },
            },
          },
          async ({ controller }) => {
            const fakeMetamaskProvider = buildFakeMetamaskProvider();
            createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
            const promiseForStateChange = new Promise<void>((resolve) => {
              messenger.subscribe('NetworkController:stateChange', () => {
                resolve();
              });
            });

            controller.setProviderType('localhost' as const);

            await promiseForStateChange;
            expect(controller.state.providerConfig).toStrictEqual({
              type: 'localhost',
              ticker: 'ETH',
              chainId: '',
              rpcTarget: undefined,
              nickname: undefined,
            });
          },
        );
      });

      it('sets isCustomNetwork in state to false', async () => {
        const messenger = buildMessenger();
        await withController(
          {
            messenger,
            state: {
              isCustomNetwork: true,
            },
          },
          async ({ controller }) => {
            const fakeMetamaskProvider = buildFakeMetamaskProvider();
            createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
            const promiseForIsCustomNetworkChange = new Promise<void>(
              (resolve) => {
                messenger.subscribe(
                  'NetworkController:stateChange',
                  (_, patches) => {
                    if (didPropertyChange(patches, ['isCustomNetwork'])) {
                      resolve();
                    }
                  },
                );
              },
            );

            controller.setProviderType('localhost' as const);

            await promiseForIsCustomNetworkChange;
            expect(controller.state.isCustomNetwork).toBe(false);
          },
        );
      });

      it('sets the provider to a custom RPC provider pointed to localhost, leaving chain ID undefined', async () => {
        await withController(({ controller }) => {
          const fakeMetamaskProvider = buildFakeMetamaskProvider();
          createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);

          controller.setProviderType('localhost' as const);

          expect(createMetamaskProviderMock).toHaveBeenCalledWith({
            chainId: undefined,
            engineParams: { pollingInterval: 12000 },
            nickname: undefined,
            rpcUrl: 'http://localhost:8545',
            ticker: undefined,
          });
          expect(controller.provider).toBe(fakeMetamaskProvider);
        });
      });

      it('updates properties.isEIP1559Compatible in state based on the latest block (assuming that the request eth_getBlockByNumber is made successfully)', async () => {
        const messenger = buildMessenger();
        await withController({ messenger }, async ({ controller }) => {
          const fakeMetamaskProvider = buildFakeMetamaskProvider([
            {
              request: {
                method: 'eth_getBlockByNumber',
                params: ['latest', false],
              },
              response: {
                result: {
                  baseFeePerGas: '0x1',
                },
              },
            },
          ]);
          createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
          const promiseForIsEIP1559CompatibleChange = new Promise<NetworkState>(
            (resolve) => {
              messenger.subscribe(
                'NetworkController:stateChange',
                (newState, patches) => {
                  if (
                    didPropertyChange(patches, [
                      'properties',
                      'isEIP1559Compatible',
                    ])
                  ) {
                    resolve(newState);
                  }
                },
              );
            },
          );

          controller.setProviderType('localhost' as const);

          await promiseForIsEIP1559CompatibleChange;
          expect(controller.state.properties.isEIP1559Compatible).toBe(true);
        });
      });

      it('stops an existing provider eventually', async () => {
        await withController(({ controller }) => {
          const fakeMetamaskProvider = buildFakeMetamaskProvider();
          createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
          jest.spyOn(fakeMetamaskProvider, 'stop');

          controller.setProviderType('localhost' as const);
          controller.setProviderType('localhost' as const);
          assert(controller.provider);
          jest.runAllTimers();

          expect(controller.provider.stop).toHaveBeenCalled();
        });
      });

      it('updates the version of the current network in state (assuming that the request to net_version is made successfully)', async () => {
        const messenger = buildMessenger();
        await withController({ messenger }, async ({ controller }) => {
          const fakeMetamaskProvider = buildFakeMetamaskProvider([
            {
              request: {
                method: 'net_version',
                params: [],
              },
              response: {
                result: '42',
              },
            },
          ]);
          createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
          const promiseForNetworkChange = new Promise<NetworkState>(
            (resolve) => {
              messenger.subscribe(
                'NetworkController:stateChange',
                (newState, patches) => {
                  if (didPropertyChange(patches, ['network'])) {
                    resolve(newState);
                  }
                },
              );
            },
          );

          controller.setProviderType('localhost' as const);

          await promiseForNetworkChange;
          expect(controller.state.network).toBe('42');
        });
      });

      describe('when an "error" event occurs on the new provider', () => {
        describe('if the network version could not be retrieved during setProviderType', () => {
          it('retrieves the network version again and, assuming success, persists it to state', async () => {
            const messenger = buildMessenger();
            await withController({ messenger }, async ({ controller }) => {
              const fakeMetamaskProvider = buildFakeMetamaskProvider([
                {
                  request: {
                    method: 'net_version',
                  },
                  response: {
                    error: 'oops',
                  },
                },
                {
                  request: {
                    method: 'net_version',
                  },
                  response: {
                    result: '42',
                  },
                },
              ]);
              createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
              const promiseForNetworkChange = new Promise<void>((resolve) => {
                messenger.subscribe(
                  'NetworkController:stateChange',
                  (_, patches) => {
                    if (didPropertyChange(patches, ['network'])) {
                      resolve();
                    }
                  },
                );
              });

              controller.setProviderType('localhost' as const);
              assert(controller.provider);
              controller.provider.emit('error', { some: 'error' });

              await promiseForNetworkChange;
              expect(controller.state.network).toBe('42');
            });
          });
        });

        describe('if the network version could be retrieved during setProviderType', () => {
          it('does not retrieve the network version again', async () => {
            const messenger = buildMessenger();
            await withController({ messenger }, async ({ controller }) => {
              const fakeMetamaskProvider = buildFakeMetamaskProvider([
                {
                  request: {
                    method: 'net_version',
                  },
                  response: {
                    result: '1',
                  },
                },
                {
                  request: {
                    method: 'net_version',
                  },
                  response: {
                    result: '2',
                  },
                },
              ]);
              createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);

              const promiseForFirstNetworkChange = waitForStateChange(
                messenger,
                ['network'],
              );
              controller.setProviderType('localhost' as const);
              assert(controller.provider);
              await promiseForFirstNetworkChange;
              expect(controller.state.network).toBe('1');

              const promiseForNextNetworkChange = waitForStateChange(
                messenger,
                ['network'],
              );
              controller.provider.emit('error', { some: 'error' });
              await expect(promiseForNextNetworkChange).toNeverResolve();
            });
          });
        });
      });
    });
  });

  describe('setRpcTarget', () => {
    describe('given only an RPC target and chain ID', () => {
      it('updates the provider config in state with the RPC target and chain ID, clearing any existing ticker and nickname', async () => {
        const messenger = buildMessenger();
        await withController(
          {
            messenger,
            state: {
              providerConfig: {
                type: 'localhost',
                rpcTarget: 'http://somethingexisting.com',
                chainId: '99999',
                ticker: 'something existing',
                nickname: 'something existing',
              },
            },
          },
          async ({ controller }) => {
            const fakeMetamaskProvider = buildFakeMetamaskProvider();
            createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
            const promiseForStateChange = new Promise<void>((resolve) => {
              messenger.subscribe('NetworkController:stateChange', () => {
                resolve();
              });
            });

            controller.setRpcTarget('http://example.com', '123');

            await promiseForStateChange;
            expect(controller.state.providerConfig).toStrictEqual({
              type: 'rpc',
              rpcTarget: 'http://example.com',
              chainId: '123',
              ticker: undefined,
              nickname: undefined,
            });
          },
        );
      });

      it('sets isCustomNetwork in state to true', async () => {
        const messenger = buildMessenger();
        await withController(
          {
            messenger,
            state: {
              isCustomNetwork: false,
            },
          },
          async ({ controller }) => {
            const fakeMetamaskProvider = buildFakeMetamaskProvider();
            createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
            const promiseForIsCustomNetworkChange = new Promise<void>(
              (resolve) => {
                messenger.subscribe(
                  'NetworkController:stateChange',
                  (_, patches) => {
                    if (didPropertyChange(patches, ['isCustomNetwork'])) {
                      resolve();
                    }
                  },
                );
              },
            );

            controller.setRpcTarget('http://example.com', '123');

            await promiseForIsCustomNetworkChange;
            expect(controller.state.isCustomNetwork).toBe(true);
          },
        );
      });

      it('sets the provider to a custom RPC provider initialized with the RPC target and chain ID, leaving nickname and ticker undefined', async () => {
        await withController(({ controller }) => {
          const fakeMetamaskProvider = buildFakeMetamaskProvider();
          createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);

          controller.setRpcTarget('http://example.com', '123');

          expect(createMetamaskProviderMock).toHaveBeenCalledWith({
            chainId: '123',
            engineParams: { pollingInterval: 12000 },
            nickname: undefined,
            rpcUrl: 'http://example.com',
            ticker: undefined,
          });
          expect(controller.provider).toBe(fakeMetamaskProvider);
        });
      });

      it('updates properties.isEIP1559Compatible in state based on the latest block (assuming that the request to eth_getBlockByNumber is made successfully)', async () => {
        const messenger = buildMessenger();
        await withController({ messenger }, async ({ controller }) => {
          const fakeMetamaskProvider = buildFakeMetamaskProvider([
            {
              request: {
                method: 'eth_getBlockByNumber',
                params: ['latest', false],
              },
              response: {
                result: {
                  baseFeePerGas: '0x1',
                },
              },
            },
          ]);
          createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
          const promiseForIsEIP1559CompatibleChange = new Promise<NetworkState>(
            (resolve) => {
              messenger.subscribe(
                'NetworkController:stateChange',
                (newState, patches) => {
                  if (
                    didPropertyChange(patches, [
                      'properties',
                      'isEIP1559Compatible',
                    ])
                  ) {
                    resolve(newState);
                  }
                },
              );
            },
          );

          controller.setRpcTarget('http://example.com', '123');

          await promiseForIsEIP1559CompatibleChange;
          expect(controller.state.properties.isEIP1559Compatible).toBe(true);
        });
      });

      it('stops an existing provider eventually', async () => {
        await withController(({ controller }) => {
          const fakeMetamaskProvider = buildFakeMetamaskProvider();
          createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
          jest.spyOn(fakeMetamaskProvider, 'stop');

          controller.setRpcTarget('http://example.com', '123');
          controller.setRpcTarget('http://example.com', '123');
          assert(controller.provider);
          jest.runAllTimers();

          expect(controller.provider.stop).toHaveBeenCalled();
        });
      });

      it('updates the version of the current network in state (assuming that the request to net_version is made successfully)', async () => {
        const messenger = buildMessenger();
        await withController({ messenger }, async ({ controller }) => {
          const fakeMetamaskProvider = buildFakeMetamaskProvider([
            {
              request: {
                method: 'net_version',
                params: [],
              },
              response: {
                result: '42',
              },
            },
          ]);
          createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
          const promiseForNetworkChange = new Promise<NetworkState>(
            (resolve) => {
              messenger.subscribe(
                'NetworkController:stateChange',
                (newState, patches) => {
                  if (didPropertyChange(patches, ['network'])) {
                    resolve(newState);
                  }
                },
              );
            },
          );

          controller.setRpcTarget('http://example.com', '123');

          await promiseForNetworkChange;
          expect(controller.state.network).toBe('42');
        });
      });

      describe('when an "error" event occurs on the new provider', () => {
        describe('if the network version could not be retrieved during setRpcTarget', () => {
          it('retrieves the network version again and, assuming success, persists it to state', async () => {
            const messenger = buildMessenger();
            await withController({ messenger }, async ({ controller }) => {
              const fakeMetamaskProvider = buildFakeMetamaskProvider([
                {
                  request: {
                    method: 'net_version',
                  },
                  response: {
                    error: 'oops',
                  },
                },
                {
                  request: {
                    method: 'net_version',
                  },
                  response: {
                    result: '42',
                  },
                },
              ]);
              createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
              const promiseForNetworkChange = new Promise<void>((resolve) => {
                messenger.subscribe(
                  'NetworkController:stateChange',
                  (_, patches) => {
                    if (didPropertyChange(patches, ['network'])) {
                      resolve();
                    }
                  },
                );
              });

              controller.setRpcTarget('http://example.com', '123');
              assert(controller.provider);
              controller.provider.emit('error', { some: 'error' });

              await promiseForNetworkChange;
              expect(controller.state.network).toBe('42');
            });
          });
        });

        describe('if the network version could be retrieved during setRpcTarget', () => {
          it('does not retrieve the network version again', async () => {
            const messenger = buildMessenger();
            await withController({ messenger }, async ({ controller }) => {
              const fakeMetamaskProvider = buildFakeMetamaskProvider([
                {
                  request: {
                    method: 'net_version',
                  },
                  response: {
                    result: '1',
                  },
                },
                {
                  request: {
                    method: 'net_version',
                  },
                  response: {
                    result: '2',
                  },
                },
              ]);
              createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);

              const promiseForFirstNetworkChange = waitForStateChange(
                messenger,
                ['network'],
              );
              controller.setRpcTarget('http://example.com', '123');
              assert(controller.provider);
              await promiseForFirstNetworkChange;
              expect(controller.state.network).toBe('1');

              const promiseForNextNetworkChange = waitForStateChange(
                messenger,
                ['network'],
              );
              controller.provider.emit('error', { some: 'error' });
              await expect(promiseForNextNetworkChange).toNeverResolve();
            });
          });
        });
      });
    });

    describe('given an RPC target, chain ID, ticker, and nickname', () => {
      it('updates the provider config in state with the RPC target, chain ID, ticker, and nickname', async () => {
        const messenger = buildMessenger();
        await withController(
          {
            messenger,
            state: {
              providerConfig: {
                type: 'localhost',
                rpcTarget: 'http://somethingexisting.com',
                chainId: '99999',
                ticker: 'something existing',
                nickname: 'something existing',
              },
            },
          },
          async ({ controller }) => {
            const fakeMetamaskProvider = buildFakeMetamaskProvider();
            createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
            const promiseForStateChange = new Promise<void>((resolve) => {
              messenger.subscribe('NetworkController:stateChange', () => {
                resolve();
              });
            });

            controller.setRpcTarget(
              'http://example.com',
              '123',
              'ABC',
              'cool network',
            );

            await promiseForStateChange;
            expect(controller.state.providerConfig).toStrictEqual({
              type: 'rpc',
              rpcTarget: 'http://example.com',
              chainId: '123',
              ticker: 'ABC',
              nickname: 'cool network',
            });
          },
        );
      });

      it('sets isCustomNetwork in state to true', async () => {
        const messenger = buildMessenger();
        await withController(
          {
            messenger,
            state: {
              isCustomNetwork: false,
            },
          },
          async ({ controller }) => {
            const fakeMetamaskProvider = buildFakeMetamaskProvider();
            createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
            const promiseForIsCustomNetworkChange = new Promise<void>(
              (resolve) => {
                messenger.subscribe(
                  'NetworkController:stateChange',
                  (_, patches) => {
                    if (didPropertyChange(patches, ['isCustomNetwork'])) {
                      resolve();
                    }
                  },
                );
              },
            );

            controller.setRpcTarget(
              'http://example.com',
              '123',
              'ABC',
              'cool network',
            );

            await promiseForIsCustomNetworkChange;
            expect(controller.state.isCustomNetwork).toBe(true);
          },
        );
      });

      it('sets the provider to a custom RPC provider initialized with the RPC target, chain ID, and ticker, ignoring the nickname', async () => {
        await withController(({ controller }) => {
          const fakeMetamaskProvider = buildFakeMetamaskProvider();
          createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);

          controller.setRpcTarget(
            'http://example.com',
            '123',
            'ABC',
            'cool network',
          );

          expect(createMetamaskProviderMock).toHaveBeenCalledWith({
            chainId: '123',
            engineParams: { pollingInterval: 12000 },
            nickname: undefined,
            rpcUrl: 'http://example.com',
            ticker: 'ABC',
          });
          expect(controller.provider).toBe(fakeMetamaskProvider);
        });
      });

      it('updates properties.isEIP1559Compatible in state based on the latest block (assuming that the request to eth_getBlockByNumber is made successfully)', async () => {
        const messenger = buildMessenger();
        await withController({ messenger }, async ({ controller }) => {
          const fakeMetamaskProvider = buildFakeMetamaskProvider([
            {
              request: {
                method: 'eth_getBlockByNumber',
                params: ['latest', false],
              },
              response: {
                result: {
                  baseFeePerGas: '0x1',
                },
              },
            },
          ]);
          createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
          const promiseForIsEIP1559CompatibleChange = new Promise<NetworkState>(
            (resolve) => {
              messenger.subscribe(
                'NetworkController:stateChange',
                (newState, patches) => {
                  if (
                    didPropertyChange(patches, [
                      'properties',
                      'isEIP1559Compatible',
                    ])
                  ) {
                    resolve(newState);
                  }
                },
              );
            },
          );

          controller.setRpcTarget(
            'http://example.com',
            '123',
            'ABC',
            'cool network',
          );

          await promiseForIsEIP1559CompatibleChange;
          expect(controller.state.properties.isEIP1559Compatible).toBe(true);
        });
      });

      it('stops an existing provider eventually', async () => {
        await withController(({ controller }) => {
          const fakeMetamaskProvider = buildFakeMetamaskProvider();
          createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
          jest.spyOn(fakeMetamaskProvider, 'stop');

          controller.setRpcTarget(
            'http://example.com',
            '123',
            'ABC',
            'cool network',
          );
          controller.setRpcTarget(
            'http://example.com',
            '123',
            'ABC',
            'cool network',
          );
          assert(controller.provider);
          jest.runAllTimers();

          expect(controller.provider.stop).toHaveBeenCalled();
        });
      });

      it('updates the version of the current network in state (assuming that the request to net_version is made successfully)', async () => {
        const messenger = buildMessenger();
        await withController({ messenger }, async ({ controller }) => {
          const fakeMetamaskProvider = buildFakeMetamaskProvider([
            {
              request: {
                method: 'net_version',
                params: [],
              },
              response: {
                result: '42',
              },
            },
          ]);
          createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
          const promiseForNetworkChange = new Promise<NetworkState>(
            (resolve) => {
              messenger.subscribe(
                'NetworkController:stateChange',
                (newState, patches) => {
                  if (didPropertyChange(patches, ['network'])) {
                    resolve(newState);
                  }
                },
              );
            },
          );

          controller.setRpcTarget(
            'http://example.com',
            '123',
            'ABC',
            'cool network',
          );

          await promiseForNetworkChange;
          expect(controller.state.network).toBe('42');
        });
      });

      describe('when an "error" event occurs on the new provider', () => {
        describe('if the network version could not be retrieved during setRpcTarget', () => {
          it('retrieves the network version again and, assuming success, persists it to state', async () => {
            const messenger = buildMessenger();
            await withController({ messenger }, async ({ controller }) => {
              const fakeMetamaskProvider = buildFakeMetamaskProvider([
                {
                  request: {
                    method: 'net_version',
                  },
                  response: {
                    error: 'oops',
                  },
                },
                {
                  request: {
                    method: 'net_version',
                  },
                  response: {
                    result: '42',
                  },
                },
              ]);
              createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
              const promiseForNetworkChange = new Promise<void>((resolve) => {
                messenger.subscribe(
                  'NetworkController:stateChange',
                  (_, patches) => {
                    if (didPropertyChange(patches, ['network'])) {
                      resolve();
                    }
                  },
                );
              });

              controller.setRpcTarget(
                'http://example.com',
                '123',
                'ABC',
                'cool network',
              );
              assert(controller.provider);
              controller.provider.emit('error', { some: 'error' });

              await promiseForNetworkChange;
              expect(controller.state.network).toBe('42');
            });
          });
        });

        describe('if the network version could be retrieved during setRpcTarget', () => {
          it('does not retrieve the network version again', async () => {
            const messenger = buildMessenger();
            await withController({ messenger }, async ({ controller }) => {
              const fakeMetamaskProvider = buildFakeMetamaskProvider([
                {
                  request: {
                    method: 'net_version',
                  },
                  response: {
                    result: '1',
                  },
                },
                {
                  request: {
                    method: 'net_version',
                  },
                  response: {
                    result: '2',
                  },
                },
              ]);
              createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);

              const promiseForFirstNetworkChange = waitForStateChange(
                messenger,
                ['network'],
              );
              controller.setRpcTarget(
                'http://example.com',
                '123',
                'ABC',
                'cool network',
              );
              assert(controller.provider);
              await promiseForFirstNetworkChange;
              expect(controller.state.network).toBe('1');

              const promiseForNextNetworkChange = waitForStateChange(
                messenger,
                ['network'],
              );
              controller.provider.emit('error', { some: 'error' });
              await expect(promiseForNextNetworkChange).toNeverResolve();
            });
          });
        });
      });
    });
  });

  describe('getEIP1559Compatibility', () => {
    describe('if the state does not have a "properties" property', () => {
      describe("but ethQuery doesn't have a sendAsync function", () => {
        it('makes no state changes', async () => {
          const messenger = buildMessenger();
          await withController(
            {
              messenger,
              state: {
                // no "properties" property
              },
            },
            async ({ controller }) => {
              const fakeEthQuery = {};
              jest
                .spyOn(ethQueryModule, 'default')
                .mockReturnValue(fakeEthQuery);
              await setFakeProvider(controller, {
                stubGetEIP1559CompatibilityWhileSetting: true,
              });
              const promiseForStateChange = new Promise<void>((resolve) => {
                messenger.subscribe('NetworkController:stateChange', () => {
                  resolve();
                });
              });

              await controller.getEIP1559Compatibility();

              await expect(promiseForStateChange).toNeverResolve();
            },
          );
        });

        it('returns a promise that resolves to true', async () => {
          await withController(
            {
              state: {
                // no "properties" property
              },
            },
            async ({ controller }) => {
              const fakeEthQuery = {};
              jest
                .spyOn(ethQueryModule, 'default')
                .mockReturnValue(fakeEthQuery);
              await setFakeProvider(controller, {
                stubGetEIP1559CompatibilityWhileSetting: true,
              });

              const result = await controller.getEIP1559Compatibility();

              expect(result).toBe(true);
            },
          );
        });
      });

      describe('and ethQuery has a sendAsync function', () => {
        describe('if no error is thrown while fetching the latest block', () => {
          describe('if the block has a "baseFeePerGas" property', () => {
            it('updates isEIP1559Compatible in state to true', async () => {
              const messenger = buildMessenger();
              await withController(
                {
                  messenger,
                  state: {
                    // no "properties" property
                  },
                },
                async ({ controller }) => {
                  await setFakeProvider(controller, {
                    stubs: [
                      {
                        request: {
                          method: 'eth_getBlockByNumber',
                          params: ['latest', false],
                        },
                        response: {
                          result: {
                            baseFeePerGas: '0x100',
                          },
                        },
                      },
                    ],
                    stubGetEIP1559CompatibilityWhileSetting: true,
                  });
                  const promiseForStateChange = new Promise<void>((resolve) => {
                    messenger.subscribe('NetworkController:stateChange', () => {
                      resolve();
                    });
                  });

                  await controller.getEIP1559Compatibility();

                  await promiseForStateChange;
                  expect(controller.state.properties.isEIP1559Compatible).toBe(
                    true,
                  );
                },
              );
            });

            it('returns a promise that resolves to true', async () => {
              await withController(
                {
                  state: {
                    // no "properties" property
                  },
                },
                async ({ controller }) => {
                  await setFakeProvider(controller, {
                    stubs: [
                      {
                        request: {
                          method: 'eth_getBlockByNumber',
                          params: ['latest', false],
                        },
                        response: {
                          result: {
                            baseFeePerGas: '0x100',
                          },
                        },
                      },
                    ],
                    stubGetEIP1559CompatibilityWhileSetting: true,
                  });

                  const isEIP1559Compatible =
                    await controller.getEIP1559Compatibility();

                  expect(isEIP1559Compatible).toBe(true);
                },
              );
            });
          });

          describe('if the block does not have a "baseFeePerGas" property', () => {
            it('makes no state changes', async () => {
              const messenger = buildMessenger();
              await withController(
                {
                  messenger,
                  state: {
                    // no "properties" property
                  },
                },
                async ({ controller }) => {
                  await setFakeProvider(controller, {
                    stubs: [
                      {
                        request: {
                          method: 'eth_getBlockByNumber',
                          params: ['latest', false],
                        },
                        response: {
                          result: {
                            // no "baseFeePerGas" property
                          },
                        },
                      },
                    ],
                    stubGetEIP1559CompatibilityWhileSetting: true,
                  });
                  const promiseForStateChange = new Promise<void>((resolve) => {
                    messenger.subscribe('NetworkController:stateChange', () => {
                      resolve();
                    });
                  });

                  await controller.getEIP1559Compatibility();

                  await expect(promiseForStateChange).toNeverResolve();
                },
              );
            });

            it('returns a promise that resolves to false', async () => {
              await withController(
                {
                  state: {
                    // no "properties" property
                  },
                },
                async ({ controller }) => {
                  await setFakeProvider(controller, {
                    stubs: [
                      {
                        request: {
                          method: 'eth_getBlockByNumber',
                          params: ['latest', false],
                        },
                        response: {
                          result: {
                            // no "baseFeePerGas" property
                          },
                        },
                      },
                    ],
                    stubGetEIP1559CompatibilityWhileSetting: true,
                  });

                  const isEIP1559Compatible =
                    await controller.getEIP1559Compatibility();

                  expect(isEIP1559Compatible).toBe(false);
                },
              );
            });
          });
        });

        describe('if an error is thrown while fetching the latest block', () => {
          it('makes no state changes', async () => {
            const messenger = buildMessenger();
            await withController(
              {
                messenger,
                state: {
                  // no "properties" property
                },
              },
              async ({ controller }) => {
                await setFakeProvider(controller, {
                  stubs: [
                    {
                      request: {
                        method: 'eth_getBlockByNumber',
                        params: ['latest', false],
                      },
                      response: {
                        error: 'oops',
                      },
                    },
                  ],
                  stubGetEIP1559CompatibilityWhileSetting: true,
                });
                const promiseForStateChange = new Promise<void>((resolve) => {
                  messenger.subscribe('NetworkController:stateChange', () => {
                    resolve();
                  });
                });

                try {
                  await controller.getEIP1559Compatibility();
                } catch (error) {
                  // catch the rejection (it is tested below)
                }

                await expect(promiseForStateChange).toNeverResolve();
              },
            );
          });

          it('returns a promise that rejects with the error', async () => {
            await withController(
              {
                state: {
                  // no "properties" property
                },
              },
              async ({ controller }) => {
                await setFakeProvider(controller, {
                  stubs: [
                    {
                      request: {
                        method: 'eth_getBlockByNumber',
                        params: ['latest', false],
                      },
                      response: {
                        error: 'oops',
                      },
                    },
                  ],
                  stubGetEIP1559CompatibilityWhileSetting: true,
                });

                const promiseForIsEIP1559Compatible =
                  controller.getEIP1559Compatibility();

                await expect(promiseForIsEIP1559Compatible).rejects.toThrow(
                  'oops',
                );
              },
            );
          });
        });
      });
    });

    describe('if the state has a "properties" property, but it does not have an "isEIP1559Compatible" property', () => {
      describe("but ethQuery doesn't have a sendAsync function", () => {
        it('makes no state changes', async () => {
          const messenger = buildMessenger();
          await withController(
            {
              messenger,
              state: {
                properties: {
                  // no "isEIP1559Compatible" property
                },
              },
            },
            async ({ controller }) => {
              const fakeEthQuery = {};
              jest
                .spyOn(ethQueryModule, 'default')
                .mockReturnValue(fakeEthQuery);
              await setFakeProvider(controller, {
                stubGetEIP1559CompatibilityWhileSetting: true,
              });
              const promiseForStateChange = new Promise<void>((resolve) => {
                messenger.subscribe('NetworkController:stateChange', () => {
                  resolve();
                });
              });

              await controller.getEIP1559Compatibility();

              await expect(promiseForStateChange).toNeverResolve();
            },
          );
        });

        it('returns a promise that resolves to true', async () => {
          await withController(
            {
              state: {
                properties: {
                  // no "isEIP1559Compatible" property
                },
              },
            },
            async ({ controller }) => {
              const fakeEthQuery = {};
              jest
                .spyOn(ethQueryModule, 'default')
                .mockReturnValue(fakeEthQuery);
              await setFakeProvider(controller, {
                stubGetEIP1559CompatibilityWhileSetting: true,
              });

              const result = await controller.getEIP1559Compatibility();

              expect(result).toBe(true);
            },
          );
        });
      });

      describe('and ethQuery has a sendAsync function', () => {
        describe('if no error is thrown while fetching the latest block', () => {
          describe('if the block has a "baseFeePerGas" property', () => {
            it('updates isEIP1559Compatible in state to true', async () => {
              const messenger = buildMessenger();
              await withController(
                {
                  messenger,
                  state: {
                    properties: {
                      // no "isEIP1559Compatible" property
                    },
                  },
                },
                async ({ controller }) => {
                  await setFakeProvider(controller, {
                    stubs: [
                      {
                        request: {
                          method: 'eth_getBlockByNumber',
                          params: ['latest', false],
                        },
                        response: {
                          result: {
                            baseFeePerGas: '0x100',
                          },
                        },
                      },
                    ],
                    stubGetEIP1559CompatibilityWhileSetting: true,
                  });
                  const promiseForStateChange = new Promise<void>((resolve) => {
                    messenger.subscribe('NetworkController:stateChange', () => {
                      resolve();
                    });
                  });

                  await controller.getEIP1559Compatibility();

                  await promiseForStateChange;
                  expect(controller.state.properties.isEIP1559Compatible).toBe(
                    true,
                  );
                },
              );
            });

            it('returns a promise that resolves to true', async () => {
              await withController(
                {
                  state: {
                    properties: {
                      // no "isEIP1559Compatible" property
                    },
                  },
                },
                async ({ controller }) => {
                  await setFakeProvider(controller, {
                    stubs: [
                      {
                        request: {
                          method: 'eth_getBlockByNumber',
                          params: ['latest', false],
                        },
                        response: {
                          result: {
                            baseFeePerGas: '0x100',
                          },
                        },
                      },
                    ],
                    stubGetEIP1559CompatibilityWhileSetting: true,
                  });

                  const isEIP1559Compatible =
                    await controller.getEIP1559Compatibility();

                  expect(isEIP1559Compatible).toBe(true);
                },
              );
            });
          });

          describe('if the block does not have a "baseFeePerGas" property', () => {
            it('updates isEIP1559Compatible in state to false', async () => {
              const messenger = buildMessenger();
              await withController(
                {
                  messenger,
                  state: {
                    properties: {
                      // no "isEIP1559Compatible" property
                    },
                  },
                },
                async ({ controller }) => {
                  await setFakeProvider(controller, {
                    stubs: [
                      {
                        request: {
                          method: 'eth_getBlockByNumber',
                          params: ['latest', false],
                        },
                        response: {
                          result: {
                            // no "baseFeePerGas" property
                          },
                        },
                      },
                    ],
                    stubGetEIP1559CompatibilityWhileSetting: true,
                  });
                  const promiseForStateChange = new Promise<void>((resolve) => {
                    messenger.subscribe('NetworkController:stateChange', () => {
                      resolve();
                    });
                  });

                  await controller.getEIP1559Compatibility();

                  await promiseForStateChange;
                  expect(controller.state.properties.isEIP1559Compatible).toBe(
                    false,
                  );
                },
              );
            });

            it('returns a promise that resolves to false', async () => {
              await withController(
                {
                  state: {
                    properties: {
                      // no "isEIP1559Compatible" property
                    },
                  },
                },
                async ({ controller }) => {
                  await setFakeProvider(controller, {
                    stubs: [
                      {
                        request: {
                          method: 'eth_getBlockByNumber',
                          params: ['latest', false],
                        },
                        response: {
                          result: {
                            // no "baseFeePerGas" property
                          },
                        },
                      },
                    ],
                    stubGetEIP1559CompatibilityWhileSetting: true,
                  });

                  const isEIP1559Compatible =
                    await controller.getEIP1559Compatibility();

                  expect(isEIP1559Compatible).toBe(false);
                },
              );
            });
          });
        });

        describe('if an error is thrown while fetching the latest block', () => {
          it('makes no state changes', async () => {
            const messenger = buildMessenger();
            await withController(
              {
                messenger,
                state: {
                  properties: {
                    // no "isEIP1559Compatible" property
                  },
                },
              },
              async ({ controller }) => {
                await setFakeProvider(controller, {
                  stubs: [
                    {
                      request: {
                        method: 'eth_getBlockByNumber',
                        params: ['latest', false],
                      },
                      response: {
                        error: 'oops',
                      },
                    },
                  ],
                  stubGetEIP1559CompatibilityWhileSetting: true,
                });
                const promiseForStateChange = new Promise<void>((resolve) => {
                  messenger.subscribe('NetworkController:stateChange', () => {
                    resolve();
                  });
                });

                try {
                  await controller.getEIP1559Compatibility();
                } catch (error) {
                  // catch the rejection (it is tested below)
                }

                await expect(promiseForStateChange).toNeverResolve();
              },
            );
          });

          it('returns a promise that rejects with the error', async () => {
            await withController(
              {
                state: {
                  properties: {
                    // no "isEIP1559Compatible" property
                  },
                },
              },
              async ({ controller }) => {
                await setFakeProvider(controller, {
                  stubs: [
                    {
                      request: {
                        method: 'eth_getBlockByNumber',
                        params: ['latest', false],
                      },
                      response: {
                        error: 'oops',
                      },
                    },
                  ],
                  stubGetEIP1559CompatibilityWhileSetting: true,
                });

                const promiseForIsEIP1559Compatible =
                  controller.getEIP1559Compatibility();

                await expect(promiseForIsEIP1559Compatible).rejects.toThrow(
                  'oops',
                );
              },
            );
          });
        });
      });
    });

    describe('if isEIP1559Compatible in state is set to false', () => {
      describe("but ethQuery doesn't have a sendAsync function", () => {
        it('makes no state changes', async () => {
          const messenger = buildMessenger();
          await withController(
            {
              messenger,
              state: {
                properties: {
                  isEIP1559Compatible: false,
                },
              },
            },
            async ({ controller }) => {
              const fakeEthQuery = {};
              jest
                .spyOn(ethQueryModule, 'default')
                .mockReturnValue(fakeEthQuery);
              await setFakeProvider(controller, {
                stubGetEIP1559CompatibilityWhileSetting: true,
              });
              const promiseForStateChange = new Promise<void>((resolve) => {
                messenger.subscribe('NetworkController:stateChange', () => {
                  resolve();
                });
              });

              await controller.getEIP1559Compatibility();

              await expect(promiseForStateChange).toNeverResolve();
            },
          );
        });

        it('returns a promise that resolves to true', async () => {
          await withController(
            {
              state: {
                properties: {
                  isEIP1559Compatible: false,
                },
              },
            },
            async ({ controller }) => {
              const fakeEthQuery = {};
              jest
                .spyOn(ethQueryModule, 'default')
                .mockReturnValue(fakeEthQuery);
              await setFakeProvider(controller, {
                stubGetEIP1559CompatibilityWhileSetting: true,
              });

              const result = await controller.getEIP1559Compatibility();

              expect(result).toBe(true);
            },
          );
        });
      });

      describe('and ethQuery has a sendAsync function', () => {
        describe('if no error is thrown while fetching the latest block', () => {
          describe('if the block has a "baseFeePerGas" property', () => {
            it('updates isEIP1559Compatible in state to true', async () => {
              const messenger = buildMessenger();
              await withController(
                {
                  messenger,
                  state: {
                    properties: {
                      isEIP1559Compatible: false,
                    },
                  },
                },
                async ({ controller }) => {
                  await setFakeProvider(controller, {
                    stubs: [
                      {
                        request: {
                          method: 'eth_getBlockByNumber',
                          params: ['latest', false],
                        },
                        response: {
                          result: {
                            baseFeePerGas: '0x100',
                          },
                        },
                      },
                    ],
                    stubGetEIP1559CompatibilityWhileSetting: true,
                  });
                  const promiseForStateChange = new Promise<void>((resolve) => {
                    messenger.subscribe('NetworkController:stateChange', () => {
                      resolve();
                    });
                  });

                  await controller.getEIP1559Compatibility();

                  await promiseForStateChange;
                  expect(controller.state.properties.isEIP1559Compatible).toBe(
                    true,
                  );
                },
              );
            });

            it('returns a promise that resolves to true', async () => {
              await withController(
                {
                  state: {
                    properties: {
                      isEIP1559Compatible: false,
                    },
                  },
                },
                async ({ controller }) => {
                  await setFakeProvider(controller, {
                    stubs: [
                      {
                        request: {
                          method: 'eth_getBlockByNumber',
                          params: ['latest', false],
                        },
                        response: {
                          result: {
                            baseFeePerGas: '0x100',
                          },
                        },
                      },
                    ],
                    stubGetEIP1559CompatibilityWhileSetting: true,
                  });

                  const isEIP1559Compatible =
                    await controller.getEIP1559Compatibility();

                  expect(isEIP1559Compatible).toBe(true);
                },
              );
            });
          });

          describe('if the block does not have a "baseFeePerGas" property', () => {
            it('makes no state changes', async () => {
              const messenger = buildMessenger();
              await withController(
                {
                  messenger,
                  state: {
                    properties: {
                      isEIP1559Compatible: false,
                    },
                  },
                },
                async ({ controller }) => {
                  await setFakeProvider(controller, {
                    stubs: [
                      {
                        request: {
                          method: 'eth_getBlockByNumber',
                          params: ['latest', false],
                        },
                        response: {
                          result: {
                            // no "baseFeePerGas" property
                          },
                        },
                      },
                    ],
                    stubGetEIP1559CompatibilityWhileSetting: true,
                  });
                  const promiseForStateChange = new Promise<void>((resolve) => {
                    messenger.subscribe('NetworkController:stateChange', () => {
                      resolve();
                    });
                  });

                  await controller.getEIP1559Compatibility();

                  await expect(promiseForStateChange).toNeverResolve();
                },
              );
            });

            it('returns a promise that resolves to false', async () => {
              await withController(
                {
                  state: {
                    properties: {
                      isEIP1559Compatible: false,
                    },
                  },
                },
                async ({ controller }) => {
                  await setFakeProvider(controller, {
                    stubs: [
                      {
                        request: {
                          method: 'eth_getBlockByNumber',
                          params: ['latest', false],
                        },
                        response: {
                          result: {
                            // no "baseFeePerGas" property
                          },
                        },
                      },
                    ],
                    stubGetEIP1559CompatibilityWhileSetting: true,
                  });

                  const isEIP1559Compatible =
                    await controller.getEIP1559Compatibility();

                  expect(isEIP1559Compatible).toBe(false);
                },
              );
            });
          });
        });

        describe('if an error is thrown while fetching the latest block', () => {
          it('makes no state changes', async () => {
            const messenger = buildMessenger();
            await withController(
              {
                messenger,
                state: {
                  properties: {
                    isEIP1559Compatible: false,
                  },
                },
              },
              async ({ controller }) => {
                await setFakeProvider(controller, {
                  stubs: [
                    {
                      request: {
                        method: 'eth_getBlockByNumber',
                        params: ['latest', false],
                      },
                      response: {
                        error: 'oops',
                      },
                    },
                  ],
                  stubGetEIP1559CompatibilityWhileSetting: true,
                });
                const promiseForStateChange = new Promise<void>((resolve) => {
                  messenger.subscribe('NetworkController:stateChange', () => {
                    resolve();
                  });
                });

                try {
                  await controller.getEIP1559Compatibility();
                } catch (error) {
                  // catch the rejection (it is tested below)
                }

                await expect(promiseForStateChange).toNeverResolve();
              },
            );
          });

          it('returns a promise that rejects with the error', async () => {
            await withController(
              {
                state: {
                  properties: {
                    isEIP1559Compatible: false,
                  },
                },
              },
              async ({ controller }) => {
                await setFakeProvider(controller, {
                  stubs: [
                    {
                      request: {
                        method: 'eth_getBlockByNumber',
                        params: ['latest', false],
                      },
                      response: {
                        error: 'oops',
                      },
                    },
                  ],
                  stubGetEIP1559CompatibilityWhileSetting: true,
                });

                const promiseForIsEIP1559Compatible =
                  controller.getEIP1559Compatibility();

                await expect(promiseForIsEIP1559Compatible).rejects.toThrow(
                  'oops',
                );
              },
            );
          });
        });
      });
    });

    describe('if isEIP1559Compatible in state is set to true', () => {
      it('makes no state changes', async () => {
        const messenger = buildMessenger();
        await withController(
          {
            messenger,
            state: {
              properties: {
                isEIP1559Compatible: true,
              },
            },
          },
          async ({ controller }) => {
            await setFakeProvider(controller, {
              stubGetEIP1559CompatibilityWhileSetting: true,
            });
            const promiseForStateChange = new Promise<void>((resolve) => {
              messenger.subscribe('NetworkController:stateChange', () => {
                resolve();
              });
            });

            await controller.getEIP1559Compatibility();

            await expect(promiseForStateChange).toNeverResolve();
          },
        );
      });

      it('returns a promise that resolves to true', async () => {
        await withController(
          {
            state: {
              properties: {
                isEIP1559Compatible: true,
              },
            },
          },
          async ({ controller }) => {
            await setFakeProvider(controller, {
              stubGetEIP1559CompatibilityWhileSetting: true,
            });

            const result = await controller.getEIP1559Compatibility();

            expect(result).toBe(true);
          },
        );
      });
    });
  });
});

/**
 * Builds the controller messenger that NetworkController is designed to work
 * with.
 *
 * @returns The controller messenger.
 */
function buildMessenger() {
  return new ControllerMessenger<
    NetworkControllerActions,
    NetworkControllerEvents
  >().getRestricted({
    name: 'NetworkController',
    allowedActions: [],
    allowedEvents: [
      'NetworkController:providerConfigChange',
      'NetworkController:stateChange',
    ],
  });
}

type WithControllerCallback<ReturnValue> = ({
  controller,
}: {
  controller: NetworkController;
}) => Promise<ReturnValue> | ReturnValue;

type WithControllerOptions = Partial<NetworkControllerOptions>;

type WithControllerArgs<ReturnValue> =
  | [WithControllerCallback<ReturnValue>]
  | [WithControllerOptions, WithControllerCallback<ReturnValue>];

/**
 * Builds a controller based on the given options, and calls the given function
 * with that controller.
 *
 * @param args - Either a function, or an options bag + a function. The options
 * bag is equivalent to the options that NetworkController takes (although
 * `messenger` is filled in if not given); the function will be called with the
 * built controller.
 * @returns Whatever the callback returns.
 */
async function withController<ReturnValue>(
  ...args: WithControllerArgs<ReturnValue>
): Promise<ReturnValue> {
  const [{ messenger = buildMessenger(), ...rest }, fn] =
    args.length === 2 ? args : [{}, args[0]];
  const controller = new NetworkController({
    messenger,
    ...rest,
  });
  try {
    return await fn({ controller });
  } finally {
    controller.provider?.stop();
  }
}

/**
 * Builds a complete ProviderConfig object, filling in values that are not
 * provided with defaults.
 *
 * @param config - An incomplete ProviderConfig object.
 * @returns The complete ProviderConfig object.
 */
function buildProviderConfig(config: Partial<ProviderConfig> = {}) {
  return { type: 'localhost' as const, chainId: '1337', ...config };
}

/**
 * Builds an object that `createInfuraProvider` returns.
 *
 * @returns The object.
 */
function buildFakeInfuraProvider() {
  return {};
}

/**
 * Builds an object that `Subprovider` returns.
 *
 * @returns The object.
 */
function buildFakeInfuraSubprovider() {
  return {};
}

/**
 * Builds fake provider engine object that `createMetamaskProvider` returns,
 * with canned responses optionally provided for certain RPC methods.
 *
 * @param stubs - The list of RPC methods you want to stub along with their
 * responses.
 * @returns The object.
 */
function buildFakeMetamaskProvider(stubs: FakeProviderStub[] = []) {
  const completeStubs = stubs.slice();
  if (!stubs.some((stub) => stub.request.method === 'eth_getBlockByNumber')) {
    completeStubs.unshift({
      request: { method: 'eth_getBlockByNumber' },
      response: { result: '0x1' },
      discardAfterMatching: false,
    });
  }
  if (!stubs.some((stub) => stub.request.method === 'net_version')) {
    completeStubs.unshift({
      request: { method: 'net_version' },
      response: { result: '1' },
      discardAfterMatching: false,
    });
    completeStubs.unshift({
      request: { method: 'net_version' },
      response: { result: '1' },
      discardAfterMatching: false,
    });
  }
  return new FakeProviderEngine({ stubs: completeStubs });
}

/**
 * Asks the controller to set the provider in the simplest way, stubbing the
 * provider appropriately so as not to cause any errors to be thrown. This is
 * useful in tests where it doesn't matter how the provider gets set, just that
 * it does. Canned responses may be optionally provided for certain RPC methods
 * on the provider.
 *
 * @param controller - The network controller.
 * @param options - Additional options.
 * @param options.stubs - The set of RPC methods you want to stub on the
 * provider along with their responses.
 * @param options.stubLookupNetworkWhileSetting - Whether to stub the call to
 * `lookupNetwork` that happens when the provider is set. This option is useful
 * in tests that need a provider to get set but also call `lookupNetwork` on
 * their own. In this case, since the `providerConfig` setter already calls
 * `lookupNetwork` once, and since `lookupNetwork` is called out of band, the
 * test may run with unexpected results. By stubbing `lookupNetwork` before
 * setting the provider, the test is free to explicitly call it.
 * @param options.stubGetEIP1559CompatibilityWhileSetting - Whether to stub the
 * call to `getEIP1559Compatibility` that happens when the provider is set. This
 * option is useful in tests that need a provider to get set but also call
 * `getEIP1559Compatibility` on their own. In this case, since the
 * `providerConfig` setter already calls `getEIP1559Compatibility` once, and
 * since `getEIP1559Compatibility` is called out of band, the test may run with
 * unexpected results. By stubbing `getEIP1559Compatibility` before setting the
 * provider, the test is free to explicitly call it.
 * @returns The set provider.
 */
async function setFakeProvider(
  controller: NetworkController,
  {
    stubs = [],
    stubLookupNetworkWhileSetting = false,
    stubGetEIP1559CompatibilityWhileSetting = false,
  }: {
    stubs?: FakeProviderStub[];
    stubLookupNetworkWhileSetting?: boolean;
    stubGetEIP1559CompatibilityWhileSetting?: boolean;
  } = {},
): Promise<ProviderEngine> {
  const fakeMetamaskProvider = buildFakeMetamaskProvider(stubs);
  createMetamaskProviderMock.mockReturnValue(fakeMetamaskProvider);
  const lookupNetworkMock = jest.spyOn(controller, 'lookupNetwork');
  const lookupGetEIP1559CompatibilityMock = jest.spyOn(
    controller,
    'getEIP1559Compatibility',
  );

  if (stubLookupNetworkWhileSetting) {
    lookupNetworkMock.mockResolvedValue(undefined);
  }
  if (stubGetEIP1559CompatibilityWhileSetting) {
    lookupGetEIP1559CompatibilityMock.mockResolvedValue(undefined);
  }

  controller.providerConfig = buildProviderConfig();
  await waitForResult(true, () => controller.provider !== undefined);
  assert(controller.provider);

  if (stubLookupNetworkWhileSetting) {
    lookupNetworkMock.mockRestore();
  }
  if (stubGetEIP1559CompatibilityWhileSetting) {
    lookupGetEIP1559CompatibilityMock.mockRestore();
  }

  return controller.provider;
}

/**
 * Waits for state change events for a particular property to be emitted. As we
 * aren't able to assume how the state ought to be changed or how many events
 * ought to be emitted, we assume that if we haven't seen any new state change
 * events for a half a second, then no more will occur.
 *
 * @param messenger - The messenger suited for NetworkController.
 * @param propertyPath - The path of the property you expect the state changes
 * to concern.
 * @returns A promise that resolves to the list of state changes when it is
 * likely that all of them that concern the property have occurred.
 */
async function waitForAllStateChanges(
  messenger: NetworkControllerMessenger,
  propertyPath: string[],
) {
  const eventType = 'NetworkController:stateChange';
  const timeBeforeAssumingNoMoreStateChanges = 500;

  return await new Promise<[NetworkState, Patch[]][]>((resolve) => {
    // We need to declare this variable first, then assign it later, so that
    // ESLint won't complain that resetTimer is referring to this variable
    // before it's declared. And we need to use let so that we can assign it
    // below.
    /* eslint-disable-next-line prefer-const */
    let networkStateChangeListener: (
      newState: NetworkState,
      patches: Patch[],
    ) => void;
    let timer: NodeJS.Timeout | undefined;
    const stateChanges: [NetworkState, Patch[]][] = [];

    const resetTimer = () => {
      if (timer) {
        clearTimeout(timer);
      }

      timer = originalSetTimeout(() => {
        messenger.unsubscribe(eventType, networkStateChangeListener);
        resolve(stateChanges);
      }, timeBeforeAssumingNoMoreStateChanges);
    };

    networkStateChangeListener = (newState, patches) => {
      if (didPropertyChange(patches, propertyPath)) {
        stateChanges.push([newState, patches]);
        resetTimer();
      }
    };

    messenger.subscribe(eventType, networkStateChangeListener);
    resetTimer();
  });
}

/**
 * Waits for the first state change event for a particular property to be
 * emitted.
 *
 * @param messenger - The messenger suited for NetworkController.
 * @param propertyPath - The path of the property you expect the state changes
 * to concern.
 * @returns A promise that resolves when a state change event has occurred
 * concerning the property.
 */
async function waitForStateChange(
  messenger: NetworkControllerMessenger,
  propertyPath: string[],
) {
  const eventType = 'NetworkController:stateChange';

  return await new Promise<void>((resolve) => {
    const networkStateChangeListener = (
      _newState: NetworkState,
      patches: Patch[],
    ) => {
      if (didPropertyChange(patches, propertyPath)) {
        messenger.unsubscribe(eventType, networkStateChangeListener);
        resolve();
      }
    };

    messenger.subscribe(eventType, networkStateChangeListener);
  });
}

/**
 * Given a set of Immer patches, determines whether the given property was
 * added, removed, or replaced in some way.
 *
 * @param patches - The Immer patches.
 * @param propertyPath - The path to a property. For instance, if you wanted to
 * know whether `foo` has changed you'd say `["foo"]`; if `foo.bar` then `["foo", "bar"]`.
 * @returns A boolean.
 */
function didPropertyChange(patches: Patch[], propertyPath: string[]): boolean {
  // Build an array of progressively larger slices of the path.
  // For instance, `foo.bar` would turn into `[[], ["foo"], ["foo", "bar"]]`.
  // This is because any part of the path could be inserted, deleted, or
  // replaced.
  const possiblePropertyPaths = propertyPath.reduce<string[][]>(
    (array, path) => {
      return [...array, [...array[array.length - 1], path]];
    },
    [[]],
  );

  return patches.some((patch) => {
    return possiblePropertyPaths.some((path) => {
      return isDeepStrictEqual(patch.path, path);
    });
  });
}
