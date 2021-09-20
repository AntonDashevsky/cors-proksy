var http = require('http');
var https = require('https');
var config = require('./config');
var url = require('url');
var request = require('request');
var cluster = require('cluster');

http.globalAgent.maxSockets = Infinity;
https.globalAgent.maxSockets = Infinity;

var publicAddressFinder = require('public-address');
var publicIP;

publicAddressFinder(function (err, data) {
    if (!err && data) {
        publicIP = data.address;
    }
});

function addCORSHeaders(req, res) {
    if (req.headers['origin']) {
        res.setHeader('Access-Control-Allow-Origin', req.headers['origin']);
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
}

function writeResponse(res, httpCode, body) {
    res.statusCode = httpCode;
    res.end(body);
}

function sendInvalidURLResponse(res) {
    return writeResponse(res, 404, 'url must be in the form of /{some_url_here}');
}

function sendTooBigResponse(res) {
    return writeResponse(res, 413, 'the content in the request or response cannot exceed ' + config.max_request_length + ' characters.');
}

function getClientAddress(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0]
        || req.connection.remoteAddress;
}

function processRequest(req, res) {
    addCORSHeaders(req, res);

    var result = config.fetch_regex.exec(req.url);

    if (result && result.length == 2 && result[1]) {
        var remoteURL;

        try {
            remoteURL = url.parse(decodeURI(result[1]));
        } catch (e) {
            return sendInvalidURLResponse(res);
        }

        if (!remoteURL.host) {
            return writeResponse(res, 404, 'relative URLS are not supported');
        }

        if (remoteURL.protocol !== 'http:' && remoteURL.protocol !== 'https:') {
            return writeResponse(res, 400, 'only http and https are supported');
        }

        if (publicIP) {
            if (req.headers['x-forwarded-for']) {
                req.headers['x-forwarded-for'] += ', ' + publicIP;
            } else {
                req.headers['x-forwarded-for'] = req.clientIP + ', ' + publicIP;
            }
        }

        if (req.headers['host']) {
            req.headers['host'] = remoteURL.host;
        }

        delete req.headers['origin'];
        delete req.headers['referer'];

        var proxyRequest = request({
            url: remoteURL,
            headers: req.headers,
            method: req.method,
            strictSSL: false,
        });

        proxyRequest.on('error', function (err) {

            if (err.code === 'ENOTFOUND') {
                return writeResponse(res, 502, 'Host for ' + url.format(remoteURL) + ' cannot be found.');
            } else {
                console.log('Proxy Request Error (' + url.format(remoteURL) + '): ' + err.toString());
                return writeResponse(res, 500);
            }

        });

        var requestSize = 0;
        var proxyResponseSize = 0;

        req.pipe(proxyRequest).on('data', function (data) {

            requestSize += data.length;

            if (requestSize >= config.max_request_length) {
                proxyRequest.end();
                return sendTooBigResponse(res);
            }
        }).on('error', function (err) {
            writeResponse(res, 500, 'Stream Error');
        });

        proxyRequest.pipe(res).on('data', function (data) {

            proxyResponseSize += data.length;

            if (proxyResponseSize >= config.max_request_length) {
                proxyRequest.end();
                return sendTooBigResponse(res);
            }
        }).on('error', function (err) {
            writeResponse(res, 500, 'Stream Error');
        });
    } else {
        return sendInvalidURLResponse(res);
    }
}


if (cluster.isMaster) {
    for (var i = 0; i < config.cluster_process_count; i++) {
        cluster.fork();
    }
} else {
    http.createServer(function (req, res) {

        var clientIP = getClientAddress(req);

        req.clientIP = clientIP;

        if (config.enable_logging) {
            console.log('%s %s %s', (new Date()).toJSON(), clientIP, req.method, req.url);
        }

        processRequest(req, res);

    }).listen(config.port, function () {
        console.log('process started (PID ' + process.pid + ')');
    });
}
