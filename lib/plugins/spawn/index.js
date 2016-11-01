var config = require('../../../config'); // defaults to included config, all config values can be overridden as options
var stderr = require('./stderr');
var psr = require('parse-service-request');
var crypto = require('crypto');
var path = require('path');
var spawn = require('cross-spawn');

// Remark: tree-kill is important as it's possible microservices may spawn child processes 
// ( which must be killed in order to prevent zombie process / orphaned process )
var kill = require('tree-kill');

// Mapping of JavaScript functions which transform incoming request data to CLI options to target language binary
// Remark: Some binaries like node and python do not require transformation of arguments, neat!
var generateArguments = {
  bash: require('./generateCommandLineArguments/bash'),
  lua: require('./generateCommandLineArguments/lua'),
  perl: require('./generateCommandLineArguments/perl'),
  scheme: require('./generateCommandLineArguments/scheme'),
  smalltalk: require('./generateCommandLineArguments/smalltalk'),
  tcl: require('./generateCommandLineArguments/tcl')
};

var compileService = {
  "coffee": require('./compileServiceCode/coffee-script'),
  "coffee-script": require('./compileServiceCode/coffee-script'),
  "babel": require('./compileServiceCode/babel')
};

// Remark: This is the local compile cache
// This is used for storing compiled / transpiled versions of services which require build / compile steps
// By default the compileCache will exist in the process memory of `microcule` itself,
// but the caching source can be customized with a simple callback interface
var compileCache = {};

module['exports'] = function spawnService (service) {

  // create a new service object to work with locally so we don't mutate the service argument
  // we also serialize the service object and send it into the microservice as "resource",
  // so we want to make sure it only has properties that will seralize well / should be available to microservice scope
  var _service = {};
  _service.code = service.code || "";
  // _service.schema = service.schema;
  _service.language = service.lang || service.language || "javascript";

  // legacy API
  if (typeof service.source === 'string') {
    _service.code = service.source;
  }
  if (typeof _service.code === "undefined") {
    throw new Error('service.code is required!')
  }

  if (typeof _service.code === "function") {
    _service.code = "module.exports = " + _service.code.toString();
  }

  return function spawnServiceMiddleware (input, output, next) {

    input.resource = input.resource || {
      params: {}
    };

    _service.code = input.code || _service.code;

    // next callback is optional
    next = next || function (err, result) {
      console.log('warning: using default middleware next handler'.red);
      console.log(err, result)
    };

    // output.setHeader('x-powered-by', 'Stackvana');

    // legacy API properties "themeSource" and "presenterSource"
    _service.view = service.view || service.themeSource;
    service.presenter = service.presenterSource || service.presenter;

    _spawnService(input, output);

    function _spawnService (input, output) {

      // console.log('running spawn service'.blue, input.url)
      // use passed in config if its defined, if not will default to ./config folder
      if (typeof service.config === "object") {
        config = service.config;
      }

      // the logging handler can be customized to any function
      // the default logging handler is console.log,
      // but for production usage you will want to pass in a config.log that persists somewhere ( like redis )
      var log = service.log || config.log || console.log;
      input.resource = input.resource || {
        instance: {},
        params: {}
      };

      input.env = input.env || config.env || {};

      // default target spawning binary to `./binaries/javascript`,
      // this is the default node.js / javascript binary
      var targetBinary = "node";

      var targetLanguage = service.language;

      // Put some guards up for legacy "language" values still being used in production
      if (typeof targetLanguage === "undefined" || targetLanguage === "javascript" || targetLanguage === "") {
        targetLanguage = "javascript";
      }
      if (targetLanguage === "coffee") {
        targetLanguage = "coffee-script";
      }
      if (targetLanguage === "es6" || targetLanguage === "es7") {
        targetLanguage = "babel";
      }

      // before spawning service, check to see if it has a compile step,
      // if so, we must compile / check the caching options for the compiled service code
      if (typeof compileService[targetLanguage] === "function") {
        // service.code = service.code || "";
        var md5 = checksum(_service.code);

        if (typeof compileCache[md5] === "undefined") {
          // no cached version found, compile and add
          console.log('detected new microservice. compiling: ' + md5 + "...");
          var compiled = compileService[targetLanguage](_service.code);
          compileCache[md5] = compiled;
          _service.code = compiled;
          //service.code = compiled;
        } else {
          _service.code = compileCache[md5];
          //service.code = compileCache[md5];
          //console.log('found compiled version', md5);
        }
      }

      /*
         Possible results of spawnService

           Remark: These are to be used as a reference and are possibly not complete / correct. 
                   These cases will most likely develop these into unit tests

           vm opens -> service calls res.end -> vm closes -> response
           vm opens -> service throws error -> vm closes -> response
           vm opens -> service throws module missing -> vm closes -> npm installs -> response
           vm opens -> service throws timeout error -> vm closes -> response
           vm opens -> vm error -> vm closes -> response

        Child process spawn lifecycle

          Important: Mapping the lifecycle of spawning the child process is essential in
                     understanding which events fire in what order on various spawn conditions.
                     In many cases if we do not correctly track all STDIO and HTTP stream events,
                     we will lose the error stack from the spawned binary ( or return 500 ).
                     Error stacks from spawned services should *always* be returned to the client.
                     The client should *never* see 500 errors or stream disconnect errors.

          Child process Spawn Error lifecycle ( such as missing binary or bad options to chroot )

            vm.stdin.error
            vm.exit
            vm.stdout.end
            vm.stderr

      */

      // Remark: `status` object keep track of the various statuses that can result from spawning a service
      // It's important to understand what the vm is currently doing in order to respond correctly to the client request

      var status = {
        ended: false,
        erroring: false,
        checkingRegistry: false,
        stdoutEnded: false,
        serviceEnded: false,
        vmClosed: false,
        vmError: false
      };

      var isStreaming = false;

      if (input._readableState && input._readableState.buffer && (input._readableState.buffer.length || !input._readableState.ended)) {
        isStreaming = true;
      }

      var remoteAddress = input.connection.remoteAddress;
      // Note: Since we are proxying inside the hook.io network,
      // we should try to apply the forwarded remote IP address to the service env.
      // This will give users the ability to see the actual remote IP addresses accessing their services from inside the service
      if (typeof input.headers['x-forwarded-for'] !== "undefined") {
        remoteAddress = input.headers['x-forwarded-for'];
      }

      var __env = {
        params: input.resource.instance || input.resource.params, // instance is used in case of validation
        isStreaming: isStreaming,
        customTimeout: service.customTimeout || config.SERVICE_MAX_TIMEOUT, // replace with _service scope?
        env: input.env,
        resource: _service,
        input: {
          method: input.method,
          headers: input.headers,
          host: input.hostname,
          path: input.path,
          params: input.params,
          url: input.url,
          connection: {
            remoteAddress: remoteAddress
          }
        }
      };

      if (service.isHookio === true) {
        __env.isHookio = true;
      }

      // TODO: can we remove this line?
      if (service.language === "lua") {
        __env.resource = {};
      }

      // map users special admin access key to hook.env
      // TODO: move to config option
      // opts.env - custom environment variables / methods to inject into service handler ( defaults to {} )

      __env.hookAccessKey = input.env.hookAccessKey;

      var vm;

      var binaries = {
        "bash": "bash",
        "coffee-script": "node",
        "coffee": "node",
        "babel": "node",
        "es7": "node", // legacy name, renamed to "babel"
        "lua": "lua",
        "javascript": "node",
        "perl": "perl",
        "php": "php",
        "python": "python",
        "python3": "python3",
        "ruby": "ruby",
        "scheme": "scheme",
        "smalltalk": "gst",
        "tcl": "tcl"
      };

      targetBinary = binaries[targetLanguage];
      var binaryArgs = [];

      function preprocessCommandLineArguments (cb) {
        /*
            Generate specific command line arguments per target binary
            Warning: Will contruct a very long command line arguments string !!!
                     Average system limit appears to be about 2mb ( microservices should fall well within that limit... )

            Important: To detect system limit for command line arguments in bytes run: `getconf ARG_MAX`

            TODO: return error if size exceeds system's argv size

        */
        if (typeof generateArguments[targetLanguage] === "function") {
          binaryArgs = generateArguments[targetLanguage](_service, __env);
        } else {
          binaryArgs = [
            '-c', _service.code.toString(),
            '-e', JSON.stringify(__env),
            '-s', JSON.stringify(_service)
          ];
        }

      }

      targetBinary = __dirname + "/../../../bin/binaries/" + targetBinary;
      //console.log('spawning', targetBinary, service)
      targetBinary = path.normalize(targetBinary);
      preprocessCommandLineArguments();
      //console.log(targetBinary, binaryArgs);
      vm = spawn(targetBinary, binaryArgs /*, { stdio: [null, null, null, 'ipc'] } */);
      finish();

      function finish () {

        var hookTimeout = config.SERVICE_MAX_TIMEOUT;

        if (typeof service.customTimeout === "number") {
          hookTimeout = service.customTimeout;
        }

        var inSeconds = hookTimeout / 1000;

        var serviceCompleted = false;
        var serviceCompletedTimer = setTimeout(function(){
          if (!serviceCompleted && !status.ended && !status.checkingRegistry) {
            status.ended = true;
            output.write(config.messages.serviceExecutionTimeout(inSeconds));
            //
            // Note: At this stage, we don't know if the child process is going to exit,
            // it might exit at some point but it's execeeded SERVICE_MAX_TIMEOUT at this point,
            // and we need to gracefully kill the child process
            //
            // Remark: Uses tree-kill.kill() method,
            // this is a multi-level kill command which is suppose to kill,
            // all child processes and any subprocesses spawned by their subprocess chain
            // this should ensure we don't get zombie processes
            kill(vm.pid, 'SIGKILL', function(err) {
              if (err) {
                // Remark: When exactly can an error happen here?
                console.log("SIGKILL ERROR", err.message);
              }
              // Note: kill() is also a sync command
              // do we need to do anything with this event?
            });
            endResponse();
          }
        }, hookTimeout);

        function endResponse () {
          serviceCompletedTimer = clearTimeout(serviceCompletedTimer);
          serviceCompleted = true;
          output.end();
          // simply pass a string to the next callback
          // if we were buffering the contents of the response to memory, we could in theory,
          // continue with the entire rendered response
          // currently not seeing any use-cases for this, could add later
          next(null, 'response ended');
        };

        if (vm.stdout) {
          vm.stdout.on('data', function (data) {
            if (!status.ended && output.finished !== true) {
              output.write(data);
            }
          });
        }

        var stdoutEnded = false;
        if (vm.stdout) {
          vm.stdout.on('end', function (data) {
            status.stdoutEnded = true;
            // console.log('vm.stdout.end', status);
            if (!status.checkingRegistry && !status.ended && !status.erroring) {
              status.ended = true;
              endResponse();
            }
            if (status.vmClosed && !status.ended) {
              status.ended = true;
              endResponse();
            }
          });
        }

        if (vm.stdin) {
          vm.stdin.on('error', function (data) {
            status.stdinError = true;
            // console.log('vm.stdin.error', status, data);
            // do nothing with this error?
            // without this error handler, `run-remote-service` will experience an uncaught stream error,
            // this is bad, because we lose the error stack with the uncaught stream error
          });
        }
        // map endResponse fn for possible use in stderr.onData handler
        output.endResponse = endResponse;
        if (vm.stderr) {
          // stderr is overloaded here to be used as a one-way messaging device from child process to request
          // this is used for doing such events as logging / setting http headers
          vm.stderr.on('data', function (data) {
            // console.log('vm.stderr.data', data.toString())
            stderr.onData(data, status, log, output);
          });
        }

        vm.on('error', function (err) {
          // console.log('vm.error' + err.message);
          status.vmError = true;
          if (!status.ended) {
            status.ended = true;
            output.write(err.message);
            //console.log('vm error called endResponse()');
            endResponse();
          }
        });

        vm.on('exit', function (code, signal) {
          // console.log('vm.exit', code, signal, status);
          status.vmClosed = true;
          if (!status.checkingRegistry && !status.ended && !status.stdoutEnded ) {
            //status.ended = true;
            if (code === 1) {
              status.erroring = true;
              status.vmError = true;
              //output.write(config.messages.childProcessSpawnError(binaryArgs));
            }
            if (code > 1) {
              status.erroring = true;
              status.vmError = true;
              //output.write('Unknown spawn error code: ' + code.toString() + " please contact support.");
            }
            if (signal !== null && typeof signal !== "undefined") {
              status.erroring = true;
              status.vmError = true;
            }
            // Remark: we could call `endResponse()` here, but the child process spawn lifecycle dictates,
            // we must wait for vm.stdout.end and vm.stderr to finish ( as to not lose data )
          }
          // if stdout has ended, we should be able to end the response if the vm exits
          if (status.stdoutEnded && !status.ended) {
            status.ended = true;
            endResponse();
          }
        });

        if (vm.stdin) {
          input.pipe(vm.stdin);
        }

      }
    }
 
  };

};


function checksum (str, algorithm, encoding) {
    return crypto
        .createHash(algorithm || 'md5')
        .update(str, 'utf8')
        .digest(encoding || 'hex')
}