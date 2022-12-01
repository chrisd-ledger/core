import * as sinon from 'sinon';
import { ControllerMessenger } from '@metamask/base-controller';
import { NetworkType, NetworksChainId } from '@metamask/controller-utils';
import SafeEventEmitter from '@metamask/safe-event-emitter';
import nock from 'nock';
import {
  NetworkController,
  NetworkControllerMessenger,
  NetworkControllerOptions,
} from './NetworkController';

const RPC_TARGET = 'http://foo';

type WithMockedBlockTrackerOptions = {
  nextBlockNumber?: () => string;
};

const withMockedBlockTracker = async (
  options: WithMockedBlockTrackerOptions = {},
) => {
  const nextBlockNumber = options.nextBlockNumber
    ? options.nextBlockNumber
    : () => '0x42';

  const urlRegex = /https:\/\/.*/u;
  const anyRegex = /.*/u;
  nock(urlRegex)
    .post(anyRegex, {
      jsonrpc: '2.0',
      id: anyRegex,
      method: "eth_blockNumber",
      params: [],
    })
    .reply((_, reqBody: any) => {
      console.log(reqBody);
      return [
        200,
        { jsonrpc: '2.0', id: reqBody.id, result: nextBlockNumber() },
      ];
    })
    .persist();

  nock(urlRegex)
    .post(anyRegex, {
      jsonrpc: '2.0',
      id: anyRegex,
      method: "eth_getBlockByNumber",
      params: ["0x42", false],
    })
    .reply((_, reqBody: any) => {
      console.log(reqBody);
      return [
        200,
        { jsonrpc: '2.0', id: reqBody.id, result: {} },
      ];
    })
    .persist();
};

const setupController = (
  pType: NetworkType,
  messenger: NetworkControllerMessenger,
) => {
  const networkControllerOpts: NetworkControllerOptions = {
    infuraProjectId: 'foo',
    state: {
      network: '0',
      providerConfig: {
        type: pType,
        chainId: NetworksChainId[pType],
      },
      properties: { isEIP1559Compatible: false },
    },
    messenger,
  };
  const controller = new NetworkController(networkControllerOpts);
  return controller;
};

describe('NetworkController', () => {
  let messenger: NetworkControllerMessenger;

  beforeEach(() => {
    messenger = new ControllerMessenger().getRestricted({
      name: 'NetworkController',
      allowedEvents: ['NetworkController:providerConfigChange'],
      allowedActions: [],
    });
  });

  afterEach(() => {
    sinon.restore();
    nock.restore();
    nock.cleanAll();
  });

  it('should set default state', () => {
    const controller = new NetworkController({
      messenger,
      infuraProjectId: 'potate',
    });

    expect(controller.state).toStrictEqual({
      network: 'loading',
      isCustomNetwork: false,
      properties: { isEIP1559Compatible: false },
      providerConfig: {
        type: 'mainnet',
        chainId: '1',
      },
    });
  });

  it('should create a provider instance for default infura network', () => {
    const networkControllerOpts = {
      infuraProjectId: 'foo',
      messenger,
    };
    const controller = new NetworkController(networkControllerOpts);
    const setupInfuraProvider = jest.spyOn(NetworkController.prototype as any, 'setupInfuraProvider');
    setupInfuraProvider.mockImplementationOnce(() => { });

    controller.setProviderType(controller.state.provider.type);
    expect(setupInfuraProvider).toHaveBeenCalled();
  });

  (
    ['kovan', 'rinkeby', 'ropsten', 'mainnet'] as NetworkType[]
  ).forEach((n) => {
    it(`should create a provider instance for ${n} infura network`, () => {
      const networkController = setupController(n, messenger);

      const setupInfuraProvider = jest.spyOn(NetworkController.prototype as any, 'setupInfuraProvider');
      setupInfuraProvider.mockImplementationOnce(() => { });
      expect(networkController.state.isCustomNetwork).toBe(false);
      networkController.setProviderType(n);
      expect(setupInfuraProvider).toHaveBeenCalled();
    });
  });

  it(`should create a provider instance for localhost network`, () => {
    const networkController = setupController('localhost', messenger);

    const setupStandardProvider = jest.spyOn(
      NetworkController.prototype as any,
      'setupStandardProvider'
    );
    setupStandardProvider.mockImplementationOnce(() => { });

    expect(networkController.state.isCustomNetwork).toBe(false);
    networkController.setProviderType('localhost');
    expect(setupStandardProvider).toHaveBeenCalled();
  });

  it.only('should create a provider instance for optimism network', () => {
    const networkControllerOpts: NetworkControllerOptions = {
      infuraProjectId: 'foo',
      state: {
        network: '0',
        providerConfig: {
          rpcTarget: RPC_TARGET,
          type: 'rpc',
          chainId: '10',
        },
        properties: { isEIP1559Compatible: false },
      },
      messenger,
    };

    const controller = new NetworkController(networkControllerOpts);

    const setupStandardProvider = jest.spyOn(
      NetworkController.prototype as any,
      'setupStandardProvider'
    );
    setupStandardProvider.mockImplementationOnce(() => { });

    controller.setProviderType(controller.state.provider.type);
    expect(controller.state.isCustomNetwork).toBe(true);
    expect(setupStandardProvider).toHaveBeenCalled();
  });

  it.only('should create a provider instance for rpc network', () => {
    const networkControllerOpts: NetworkControllerOptions = {
      infuraProjectId: 'foo',
      state: {
        network: '0',
        providerConfig: {
          rpcTarget: RPC_TARGET,
          type: 'rpc',
          chainId: NetworksChainId.mainnet,
        },
      },
      messenger,
    };
    const controller = new NetworkController(networkControllerOpts);

    const setupStandardProvider = jest.spyOn(
      NetworkController.prototype as any,
      'setupStandardProvider'
    );
    setupStandardProvider.mockImplementationOnce(() => { });

    controller.setProviderType(controller.state.provider.type);
    expect(controller.state.isCustomNetwork).toBe(false);
    expect(setupStandardProvider).toHaveBeenCalled();
  });

  it('should set new RPC target', () => {
    const controller = new NetworkController({
      messenger,
      infuraProjectId: 'potate',
    });
    controller.setRpcTarget(RPC_TARGET, NetworksChainId.rpc);
    expect(controller.state.providerConfig.rpcTarget).toBe(RPC_TARGET);
    expect(controller.state.isCustomNetwork).toBe(false);
  });

  it('should set new provider type', () => {
    const controller = new NetworkController({
      messenger,
      infuraProjectId: 'potate',
    });
    controller.setProviderType('localhost');
    expect(controller.state.providerConfig.type).toBe('localhost');
    expect(controller.state.isCustomNetwork).toBe(false);
  });

  it('should set new testnet provider type', () => {
    const controller = new NetworkController({
      messenger,
      infuraProjectId: '123',
    });
    controller.setProviderType('goerli' as NetworkType);
    expect(controller.state.providerConfig.type).toBe('goerli');
    expect(controller.state.providerConfig.ticker).toBe('GoerliETH');
    expect(controller.state.isCustomNetwork).toBe(false);
    expect(controller.state.providerConfig.rpcTarget).toBeUndefined();
    expect(controller.state.providerConfig.nickname).toBeUndefined();
  });

  it('should set mainnet provider type', () => {
    const controller = new NetworkController({
      messenger,
      infuraProjectId: '123',
    });
    controller.setProviderType('mainnet' as NetworkType);
    expect(controller.state.providerConfig.type).toBe('mainnet');
    expect(controller.state.providerConfig.ticker).toBe('ETH');
    expect(controller.state.isCustomNetwork).toBe(false);
    expect(controller.state.providerConfig.rpcTarget).toBeUndefined();
    expect(controller.state.providerConfig.nickname).toBeUndefined();
  });

  it('should set rpcTarget and nickname props to undefined when set a provider type', () => {
    const controller = new NetworkController({
      messenger,
      infuraProjectId: '123',
    });
    controller.setRpcTarget(RPC_TARGET, NetworksChainId.rpc);
    controller.setProviderType('mainnet' as NetworkType);
    expect(controller.state.providerConfig.type).toBe('mainnet');
    expect(controller.state.providerConfig.ticker).toBe('ETH');
    expect(controller.state.isCustomNetwork).toBe(false);
    expect(controller.state.providerConfig.rpcTarget).toBeUndefined();
    expect(controller.state.providerConfig.nickname).toBeUndefined();
  });

  it('should throw when setting an unrecognized provider type', () => {
    const controller = new NetworkController({
      messenger,
      infuraProjectId: 'potate',
    });
    expect(() => controller.setProviderType('junk' as NetworkType)).toThrow(
      "Unrecognized network type: 'junk'",
    );
  });

  it('should verify the network on an error', async () => {
    const controller = new NetworkController({
      messenger,
      infuraProjectId: '123',
      state: {
        network: 'loading',
      },
    });
    controller.setProviderType(controller.state.provider.type);
    controller.lookupNetwork = sinon.stub();
    if (controller.provider === undefined) {
      throw new Error('provider is undefined');
    }
    controller.provider.emit('error', {});
    expect((controller.lookupNetwork as any).called).toBe(true);
  });

  it('should look up the network', async () => {
    const testConfig = {
      // This test needs a real project ID as it makes a test
      // `eth_version` call; https://github.com/MetaMask/controllers/issues/1
      infuraProjectId: '341eacb578dd44a1a049cbc5f6fd4035',
      messenger,
    };
    const event = 'NetworkController:providerConfigChange';
    const controller = new NetworkController(testConfig);

    await new Promise((resolve) => {
      const handleProviderConfigChange = () => {
        expect(controller.state.network !== 'loading').toBe(true);
        messenger.unsubscribe(event, handleProviderConfigChange);
        resolve('');
      };
      messenger.subscribe(event, handleProviderConfigChange);

      controller.setProviderType(controller.state.provider.type);
    });
  });
});
