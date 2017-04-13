
var app = angular.module('deviceSpeedCheck', []);

app.controller('ScriptController', ['$log', function($log){
  this.deviceId = "";
  this.script = function() {
    console.log(this.deviceId);
  };
}]);
