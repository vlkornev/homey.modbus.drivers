'use strict';

const Homey = require('homey');
const modbus = require('jsmodbus');
const net = require('net');
const socket = new net.Socket();

class JL204C5ModbusDevice extends Homey.Device {

  onInit() {

    let options = {
      'host': this.getSetting('address'),
      'port': this.getSetting('port'),
      'unitId': 3,
      'timeout': 5000,
      'autoReconnect': true,
      'reconnectTimeout': this.getSetting('polling'),
      'logLabel' : 'JL204C5',
      'logLevel': 'debug',
      'logEnabled': true
    }

    let client = new modbus.client.TCP(socket, options.unitId)

    socket.connect(options);
    let deviceInfo = {};
    socket.on('connect', () => {

      this.log('Connected ...')
     
      Promise.all([
        client.readInputRegisters(0, 2),//Dev_Type & Firmware_Ver and 
        client.readHoldingRegisters(86, 2),//Dev_Keys_1
        client.readHoldingRegisters(185, 1),//Humidifier_Type
        client.readHoldingRegisters(192, 1),//Cooler_Type 
      ]).then((results) => {
        this.log('Checking device ...')
        var deviceData = results[0].response._body._valuesAsArray;
        var deviceOptions = results[1].response._body._valuesAsArray;
        var humidifierType = results[2].response._body._valuesAsArray[0];
        var coolerType = results[3].response._body._valuesAsArray[0];
        deviceInfo.Type = (deviceData[0] & 0xFF00)>>8;//тип устройства
        deviceInfo.SoftwareVersion = deviceData[1];//версия прошивкм
        if (deviceInfo.Type != 2 || deviceInfo.SoftwareVersion < 0x316){
          this.log("Invalid controller or version: controller is " + deviceInfo.Type.toString(16) + "; version is " + deviceInfo.SoftwareVersion.toString(16));
          throw new Error("Invalid device!");
        }
        this.log("Controller is " + deviceInfo.Type.toString(16) + "; version is " + deviceInfo.SoftwareVersion.toString(16));
        deviceInfo.Modification = deviceData[0] & 0x00FF;//(модификация
        if (deviceInfo.Modification===1){//(вентустановка с электрическим калорифером
          deviceInfo.TempMin=5; 
          deviceInfo.TempMax=35;
        }else if (deviceInfo.Modification===2){//вентустановка с водяным калорифером
          deviceInfo.TempMin=15;
          deviceInfo.TempMax=40;
        }else{
          this.log("Invalid controller modification: the modification is " + deviceInfo.Modification.toString(16));
          throw new Error("Invalid device!");
        }
        this.log("TempMin = " + deviceInfo.TempMin+"; TempMax = " + deviceInfo.TempMax);
        deviceInfo.VAV = deviceOptions[0] & 0x4000 === 0x4000;//автоматическое поддержание давление в вент. канале (VAV - система),
        deviceInfo.HumidifierExists = humidifierType>0;// увлажнитель воздуха подключен
        deviceInfo.HumidifierType = humidifierType;
        deviceInfo.CoolerExists = coolerType>0;//охладитель воздуха подключен
        deviceInfo.CoolerType= coolerType;
        deviceInfo.ExternalTempSensorExists = deviceInfo.CoolerExists && (deviceOptions[1] & 0x0100 === 0x0100);//датчик наружного воздуха и автоматическое переключения режимов Обогрев/ Охлаждение возможно

        this.log(deviceInfo);
      }).catch((err) => {
        this.log(err);
        socket.end();
      });

    
      
      this.pollingInterval = setInterval (() => {
        Promise.all([
          client.readInputRegisters(3, 4),//CodeErr
          client.readHoldingRegisters(87, 1),//Dev_Keys_1 
          client.readInputRegisters(63, 1),//temperature 
          client.readInputRegisters(48, 1),//humidity 
          client.readInputRegisters(26, 1),//fun speed 
          client.readInputRegisters(15, 1),//filter state 
        ]).then((results) => {
          var state = results[0].response._body._valuesAsArray;
          var deviceOptions = results[1].response._body._valuesAsArray[0];
          var temperature = results[2].response._body._valuesAsArray[0];
          var humidity = results[3].response._body._valuesAsArray[0];
          var funSpeed = results[4].response._body._valuesAsArray[0];
          var filterState = results[5].response._body._valuesAsArray[0];
          var alarmcode = state[2] + state[3]*0x10000;//MBIR[5] + MBIR[6]*0x10000
          if (alarmcode>0) {
            this.log(alarmcode.toString(16));
            this.log(state[2].toString(16) +","+ state[3].toString(16));
          }
          var power = state[0] & 0x3;//MBIR[3]
          if (power==0)
            this.setCapabilityValue('onoff', true);
          else{
            this.setCapabilityValue('onoff', false);
          }
          if (deviceInfo.CoolerExists && (deviceOptions & 0x0300 === 0x0300))//есть охладитель, есть датчик наружной температуры и включено автоматическое переключение нагрев/охлажение
            this.setCapabilityValue('thermostat_mode', "auto");
          else if (state[1] & 2 > 0)//MBIR[4] режим «Обогрев»
            this.setCapabilityValue('thermostat_mode', "heat");
          else if (state[1] & 4 > 0)//MBIR[4] режим «Охлаждение»
            this.setCapabilityValue('thermostat_mode', "cool");
          else if (state[1] & 1 > 0)//MBIR[4] режим «Отключено»
            this.setCapabilityValue('thermostat_mode', "off");

          if (deviceInfo.HumidifierExists && state[1] & 8 > 0)//MBIR[4] есть увлажнитель и увлажнение разрешено
          {
            this.log("Humidifier allowed");
          }
          this.setCapabilityValue('measure_temperature', temperature/10);
          this.setCapabilityValue('measure_humidity', humidity/10);
          return;
         
          
        }).catch((err) => {
          this.log(err);
        })
      }, this.getSetting('polling'))     
      
     
    })

    socket.on('error', (err) => {
      this.log(err);
      this.setUnavailable(err.err);
      socket.end();
    })

    socket.on('close', () => {
      this.log('Connection is closed, retrying in 60 seconds');

      clearInterval(this.pollingInterval);

      setTimeout(() => {
        socket.connect(options);
        this.log('Reconnecting now ...');
      }, 6000)
    })

  }

  onDeleted() {
    clearInterval(this.pollingInterval);
  }

}

module.exports = JL204C5ModbusDevice;
