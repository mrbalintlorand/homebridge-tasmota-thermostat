import {
  AccessoryConfig,
  AccessoryPlugin,
  API,
  CharacteristicEventTypes,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  CharacteristicValue,
  HAP,
  Logging,
  Service,
} from 'homebridge';
import * as mqtt from 'mqtt';

let hap: HAP;

/*
 * Initializer function called when the plugin is loaded.
 */
export = (api: API) => {
  hap = api.hap;
  api.registerAccessory('TasmotaThermostat', TasmotaThermostat);
};
class TasmotaThermostat implements AccessoryPlugin {

  private readonly log: Logging;
  private readonly config: AccessoryConfig;
  private readonly api: API;

  private readonly name: string;
  private readonly mqttUrl: string;
  private readonly mqttName: string;

  private readonly thermostatService: Service;
  private readonly switchService: Service;

  private readonly client: mqtt.MqttClient;

  private switchOn = false;
  private currentState = hap.Characteristic.CurrentHeatingCoolingState.OFF;
  private targetState = hap.Characteristic.TargetHeatingCoolingState.OFF;
  private currentTemperature = 0;
  private currentRelativeHumidity = 0;
  private targetTemperature = 10;
  private temperatureDisplayUnits = hap.Characteristic.TemperatureDisplayUnits.CELSIUS;

  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;

    // extract name from config
    this.name = config.name;
    this.mqttUrl = config.mqtt.url;
    this.mqttName = config.mqtt.thermostat_topic_name;

    // create a new Thermostat service
    this.thermostatService = new hap.Service.Thermostat(this.name);

    // create handlers for required characteristics
    this.thermostatService.getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.handleCurrentHeatingCoolingStateGet.bind(this));

    this.thermostatService.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
      .onGet(this.handleTargetHeatingCoolingStateGet.bind(this))
      .onSet(this.handleTargetHeatingCoolingStateSet.bind(this))
      .setProps({
        validValues: [
          hap.Characteristic.TargetHeatingCoolingState.OFF,
          hap.Characteristic.TargetHeatingCoolingState.HEAT,
        ],
      });

    this.thermostatService.getCharacteristic(hap.Characteristic.CurrentRelativeHumidity)
      .onGet(this.handleCurrentRelativeHumidityStateGet.bind(this));

    this.thermostatService.getCharacteristic(hap.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this));

    this.thermostatService.getCharacteristic(hap.Characteristic.TargetTemperature)
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .onSet(this.handleTargetTemperatureSet.bind(this));

    this.thermostatService.getCharacteristic(hap.Characteristic.TemperatureDisplayUnits)
      .onGet(this.handleTemperatureDisplayUnitsGet.bind(this))
      .onSet(this.handleTemperatureDisplayUnitsSet.bind(this));

    this.switchService = new hap.Service.Switch(this.name);
    this.switchService.getCharacteristic(hap.Characteristic.On)
      .on(CharacteristicEventTypes.GET, (callback: CharacteristicGetCallback) => {
        log.info('Current state of the switch was returned: ' + (this.switchOn ? 'ON': 'OFF'));
        this.client.publish('cmnd/' + this.mqttName + '/POWER', '');
        callback(undefined, this.switchOn);
      })
      .on(CharacteristicEventTypes.SET, (value: CharacteristicValue, callback: CharacteristicSetCallback) => {
        this.switchOn = value as boolean;
        log.info('Switch state was set to: ' + (this.switchOn ? 'ON': 'OFF'));
        this.client.publish('cmnd/' + this.mqttName + '/POWER', this.switchOn ? 'ON': 'OFF');
        callback();
      });

    this.client = mqtt.connect(this.mqttUrl);

    this.client.on('connect', () => {
      this.client.subscribe('tele/' + this.mqttName + '/SENSOR', (err) => {
        if (err) {
          this.log('MQTT Sensor Subscription error:' + err);
        } else {
          this.log('MQTT Sensor Subscribed');
        }
      });
      this.client.subscribe('tele/' + this.mqttName + '/STATE', (err) => {
        if (err) {
          this.log('MQTT State Subscription error:' + err);
        } else {
          this.log('MQTT State Subscribed');
        }
      });
      this.client.subscribe('stat/' + this.mqttName + '/STATUS10', (err) => {
        if (err) {
          this.log('MQTT Status Subscription error:' + err);
        } else {
          this.log('MQTT Status Subscribed');
        }
      });
      this.client.subscribe('stat/' + this.mqttName + '/RESULT', (err) => {
        if (err) {
          this.log('MQTT Result Subscription error:' + err);
        } else {
          this.log('MQTT Result Subscribed');
        }
      });
    });

    this.client.on('message', (topic, message) => {
      // message is Buffer
      log.info('Topic: ' + topic + '\nMessage: ' + message.toString());
      const payload = JSON.parse(message.toString());
      if (topic === 'tele/' + this.mqttName + '/STATE') {
        if (payload['POWER']) {
          const power = payload['POWER'];
          this.switchOn = power === 'ON';
          this.switchService.updateCharacteristic(hap.Characteristic.On, this.switchOn);
          // this.currentState = power === 'ON' ? hap.Characteristic.CurrentHeatingCoolingState.HEAT :
          //   hap.Characteristic.CurrentHeatingCoolingState.OFF;
          // this.thermostatService.updateCharacteristic(hap.Characteristic.CurrentHeatingCoolingState, this.currentState);
        }
      }
      if (topic === 'tele/' + this.mqttName + '/SENSOR') {
        if (payload['BME280']) {
          const bme280 = payload['BME280'];
          if (bme280['Temperature']) {
            const temperature = bme280['Temperature'];
            this.currentTemperature = temperature;
            this.thermostatService.updateCharacteristic(hap.Characteristic.CurrentTemperature, temperature);
          }
          if (bme280['Humidity']) {
            const humidity = bme280['Humidity'];
            this.currentRelativeHumidity = humidity;
            this.thermostatService.updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, humidity);
          }
        }
        if (payload['Thermostat0']) {
          const thermostat0 = payload['Thermostat0'];
          if (thermostat0['ThermostatModeSet']) {
            const thermostatModeSet = thermostat0['ThermostatModeSet'];
            this.targetState = thermostatModeSet === 1 ? hap.Characteristic.TargetHeatingCoolingState.HEAT :
              hap.Characteristic.TargetHeatingCoolingState.OFF;
            this.thermostatService.updateCharacteristic(hap.Characteristic.TargetHeatingCoolingState, this.targetState);
            this.currentState = thermostatModeSet === 1 ? hap.Characteristic.CurrentHeatingCoolingState.HEAT :
              hap.Characteristic.CurrentHeatingCoolingState.OFF;
            this.thermostatService.updateCharacteristic(hap.Characteristic.CurrentHeatingCoolingState, this.currentState);
          }
          if (thermostat0['TempTargetSet']) {
            const tempTargetSet = thermostat0['TempTargetSet'];
            this.targetTemperature = tempTargetSet;
            this.thermostatService.updateCharacteristic(hap.Characteristic.TargetTemperature, this.targetTemperature);
          }
        }
      }
      if (topic === 'stat/' + this.mqttName + '/STATUS10') {
        if (payload['StatusSNS']) {
          const statusSNS = payload['StatusSNS'];
          if (statusSNS['BME280']) {
            const bme280 = statusSNS['BME280'];
            if (bme280['Temperature']) {
              const temperature = bme280['Temperature'];
              this.currentTemperature = temperature;
              this.thermostatService.updateCharacteristic(hap.Characteristic.CurrentTemperature, temperature);
            }
            if (bme280['Humidity']) {
              const humidity = bme280['Humidity'];
              this.currentRelativeHumidity = humidity;
              this.thermostatService.updateCharacteristic(hap.Characteristic.CurrentRelativeHumidity, humidity);
            }
          }
          if (statusSNS['Thermostat0']) {
            const thermostat0 = statusSNS['Thermostat0'];
            if (thermostat0['ThermostatModeSet']) {
              const thermostatModeSet = thermostat0['ThermostatModeSet'];
              this.targetState = thermostatModeSet === 1 ? hap.Characteristic.TargetHeatingCoolingState.HEAT :
                hap.Characteristic.TargetHeatingCoolingState.OFF;
              this.thermostatService.updateCharacteristic(hap.Characteristic.TargetHeatingCoolingState, this.targetState);
              this.currentState = thermostatModeSet === 1 ? hap.Characteristic.CurrentHeatingCoolingState.HEAT :
                hap.Characteristic.CurrentHeatingCoolingState.OFF;
              this.thermostatService.updateCharacteristic(hap.Characteristic.CurrentHeatingCoolingState, this.currentState);
            }
            if (thermostat0['TempTargetSet']) {
              const tempTargetSet = thermostat0['TempTargetSet'];
              this.targetTemperature = tempTargetSet;
              this.thermostatService.updateCharacteristic(hap.Characteristic.TargetTemperature, this.targetTemperature);
            }
          }
        }
      }
      if (topic === 'stat/' + this.mqttName + '/RESULT') {
        if (payload['POWER']) {
          const power = payload['POWER'];
          this.switchOn = power === 'ON';
          this.switchService.updateCharacteristic(hap.Characteristic.On, this.switchOn);
          // this.currentState = power === 'ON' ? hap.Characteristic.CurrentHeatingCoolingState.HEAT :
          //   hap.Characteristic.CurrentHeatingCoolingState.OFF;
          // this.thermostatService.updateCharacteristic(hap.Characteristic.CurrentHeatingCoolingState, this.currentState);
        }
        if (payload['ThermostatModeSet1']) {
          const thermostatModeSet1 = payload['ThermostatModeSet1'];
          this.targetState = thermostatModeSet1 === 1 ? hap.Characteristic.TargetHeatingCoolingState.HEAT :
            hap.Characteristic.TargetHeatingCoolingState.OFF;
          this.thermostatService.updateCharacteristic(hap.Characteristic.TargetHeatingCoolingState, this.targetState);
          this.currentState = thermostatModeSet1 === 1 ? hap.Characteristic.CurrentHeatingCoolingState.HEAT :
            hap.Characteristic.CurrentHeatingCoolingState.OFF;
          this.thermostatService.updateCharacteristic(hap.Characteristic.CurrentHeatingCoolingState, this.currentState);
        }
        if (payload['TempTargetSet1']) {
          const tempTargetSet1 = payload['TempTargetSet1'];
          this.targetTemperature = tempTargetSet1;
          this.thermostatService.updateCharacteristic(hap.Characteristic.TargetTemperature, this.targetTemperature);
        }
      }
    });
  }

  /**
   * Handle requests to get the current value of the "Current Heating Cooling State" characteristic
   */
  handleCurrentHeatingCoolingStateGet() {
    this.log.info('Triggered GET CurrentHeatingCoolingState');

    // this.client.publish('cmnd/' + this.mqttName + '/POWER', '');
    this.client.publish('cmnd/' + this.mqttName + '/THERMOSTATMODESET', '');

    return this.currentState;
  }


  /**
   * Handle requests to get the current value of the "Target Heating Cooling State" characteristic
   */
  handleTargetHeatingCoolingStateGet() {
    this.log.info('Triggered GET TargetHeatingCoolingState');

    this.client.publish('cmnd/' + this.mqttName + '/THERMOSTATMODESET', '');

    return this.targetState;
  }

  /**
   * Handle requests to set the "Target Heating Cooling State" characteristic
   */
  handleTargetHeatingCoolingStateSet(value: CharacteristicValue) {
    this.log.info('Triggered SET TargetHeatingCoolingState:' + value);

    this.targetState = value as number;
    this.currentState = value as number;

    if (this.targetState === hap.Characteristic.TargetHeatingCoolingState.HEAT) {
      this.client.publish('cmnd/' + this.mqttName + '/THERMOSTATMODESET', '1');
    } else {
      this.client.publish('cmnd/' + this.mqttName + '/THERMOSTATMODESET', '0');
    }
  }

  /**
   * Handle requests to get the current value of the "Current Temperature" characteristic
   */
  handleCurrentTemperatureGet() {
    this.log.info('Triggered GET CurrentTemperature');

    this.client.publish('cmnd/' + this.mqttName + '/STATUS', '10');

    return this.currentTemperature;
  }

  /**
   * Handle requests to get the current value of the "Current Relative Humidity" characteristic
   */
  handleCurrentRelativeHumidityStateGet() {
    this.log.info('Triggered GET CurrentRelativeHumidity');

    this.client.publish('cmnd/' + this.mqttName + '/STATUS', '10');

    return this.currentRelativeHumidity;
  }

  /**
   * Handle requests to get the current value of the "Target Temperature" characteristic
   */
  handleTargetTemperatureGet() {
    this.log.info('Triggered GET TargetTemperature');

    this.client.publish('cmnd/' + this.mqttName + '/TEMPTARGETSET', '');

    return this.targetTemperature;
  }

  /**
   * Handle requests to set the "Target Temperature" characteristic
   */
  handleTargetTemperatureSet(value: CharacteristicValue) {
    this.log.info('Triggered SET TargetTemperature:' + value);

    this.targetTemperature = value as number;

    this.client.publish('cmnd/' + this.mqttName + '/TEMPTARGETSET', this.targetTemperature.toString());

  }

  /**
   * Handle requests to get the current value of the "Temperature Display Units" characteristic
   */
  handleTemperatureDisplayUnitsGet() {
    this.log.info('Triggered GET TemperatureDisplayUnits');

    return this.temperatureDisplayUnits;
  }

  /**
   * Handle requests to set the "Temperature Display Units" characteristic
   */
  handleTemperatureDisplayUnitsSet(value: CharacteristicValue) {
    this.log.info('Triggered SET TemperatureDisplayUnits:' + value);

  }

  /*
   * This method is called directly after creation of this instance.
   * It should return all services which should be added to the accessory.
   */
  getServices(): Service[] {
    return [
      this.thermostatService,
      this.switchService,
    ];
  }

}