'use strict';

var httpProxy = require('http-proxy');
var net = require('net');
var url = require('url');
var getProxyForUrl = require('proxy-from-env').getProxyForUrl;

function isValidHostName(hostname) {
    return !!(
        net.isIPv4(hostname) ||
        net.isIPv6(hostname)
    );
}

var help_text = {};

function showUsage(help_file, headers, response) {
    var isHtml = /\.html$/.test(help_file);
    headers['content-type'] = isHtml ? 'text/html' : 'text/plain';
    if (help_text[help_file] != null) {
        response.writeHead(200, headers);
        response.end(help_text[help_file]);
    } else {
        require('fs').readFile(help_file, 'utf8', function (err, data) {
            if (err) {
                console.error(err);
                response.writeHead(500, headers);
                response.end();
            } else {
                help_text[help_file] = data;
                showUsage(help_file, headers, response); // Recursive call, but since data is a string, the recursion will end
            }
        });
    }
}

function withCORS(headers, request) {
    headers['access-control-allow-origin'] = '*';
    var corsMaxAge = request.corsProksyRequestState.corsMaxAge;
    if (request.method === 'OPTIONS' && corsMaxAge) {
        headers['access-control-max-age'] = corsMaxAge;
    }
    if (request.headers['access-control-request-method']) {
        headers['access-control-allow-methods'] = request.headers['access-control-request-method'];
        delete request.headers['access-control-request-method'];
    }
    if (request.headers['access-control-request-headers']) {
        headers['access-control-allow-headers'] = request.headers['access-control-request-headers'];
        delete request.headers['access-control-request-headers'];
    }

    headers['access-control-expose-headers'] = Object.keys(headers).join(',');

    return headers;
}

function proxyRequest(req, res, proxy) {
    var location = req.corsProksyRequestState.location;
    req.url = location.path;

    var proxyOptions = {
        changeOrigin: false,
        prependPath: false,
        target: location,
        headers: {
            host: location.host,
        },
        buffer: {
            pipe: function (proxyReq) {
                var proxyReqOn = proxyReq.on;
                proxyReq.on = function (eventName, listener) {
                    if (eventName !== 'response') {
                        return proxyReqOn.call(this, eventName, listener);
                    }
                    return proxyReqOn.call(this, 'response', function (proxyRes) {
                        if (onProxyResponse(proxy, proxyReq, proxyRes, req, res)) {
                            try {
                                listener(proxyRes);
                            } catch (err) {
                                proxyReq.emit('error', err);
                            }
                        }
                    });
                };
                return req.pipe(proxyReq);
            },
        },
    };

    var proxyThroughUrl = req.corsProksyRequestState.getProxyForUrl(location.href);
    if (proxyThroughUrl) {
        proxyOptions.target = proxyThroughUrl;
        proxyOptions.toProxy = true;
        // If a proxy URL was set, req.url must be an absolute URL. Then the request will not be sent
        // directly to the proxied URL, but through another proxy.
        req.url = location.href;
    }

    // Start proxying the request
    try {
        proxy.web(req, res, proxyOptions);
    } catch (err) {
        proxy.emit('error', err, req, res);
    }
}

/**
 * This method modifies the response headers of the proxied response.
 * If a redirect is detected, the response is not sent to the client,
 * and a new request is initiated.
 *
 * client (req) -> CORS Proksy -> (proxyReq) -> other server
 * client (res) <- CORS Proksy <- (proxyRes) <- other server
 *
 * @param proxy {HttpProxy}
 * @param proxyReq {ClientRequest} The outgoing request to the other server.
 * @param proxyRes {ServerResponse} The response from the other server.
 * @param req {IncomingMessage} Incoming HTTP request, augmented with property corsProksyRequestState
 * @param req.corsProksyRequestState {object}
 * @param req.corsProksyRequestState.location {object} See parseURL
 * @param req.corsProksyRequestState.getProxyForUrl {function} See proxyRequest
 * @param req.corsProksyRequestState.proxyBaseUrl {string} Base URL of the CORS API endpoint
 * @param req.corsProksyRequestState.maxRedirects {number} Maximum number of redirects
 * @param req.corsProksyRequestState.redirectCount_ {number} Internally used to count redirects
 * @param res {ServerResponse} Outgoing response to the client that wanted to proxy the HTTP request.
 *
 * @returns {boolean} true if http-proxy should continue to pipe proxyRes to res.
 */
function onProxyResponse(proxy, proxyReq, proxyRes, req, res) {
    var requestState = req.corsProksyRequestState;

    var statusCode = proxyRes.statusCode;

    if (!requestState.redirectCount_) {
        res.setHeader('x-request-url', requestState.location.href);
    }
    // Handle redirects
    if (statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307 || statusCode === 308) {
        var locationHeader = proxyRes.headers.location;
        var parsedLocation;
        if (locationHeader) {
            locationHeader = url.resolve(requestState.location.href, locationHeader);
            parsedLocation = parseURL(locationHeader);
        }
        if (parsedLocation) {
            if (statusCode === 301 || statusCode === 302 || statusCode === 303) {
                // Exclude 307 & 308, because they are rare, and require preserving the method + request body
                requestState.redirectCount_ = requestState.redirectCount_ + 1 || 1;
                if (requestState.redirectCount_ <= requestState.maxRedirects) {
                    // Handle redirects within the server, because some clients (e.g. Android Stock Browser)
                    // cancel redirects.
                    // Set header for debugging purposes. Do not try to parse it!
                    res.setHeader('X-CORS-Redirect-' + requestState.redirectCount_, statusCode + ' ' + locationHeader);

                    req.method = 'GET';
                    req.headers['content-length'] = '0';
                    delete req.headers['content-type'];
                    requestState.location = parsedLocation;

                    // Remove all listeners (=reset events to initial state)
                    req.removeAllListeners();

                    // Remove the error listener so that the ECONNRESET "error" that
                    // may occur after aborting a request does not propagate to res.
                    proxyReq.removeAllListeners('error');
                    proxyReq.once('error', function catchAndIgnoreError() {
                    });
                    proxyReq.abort();

                    // Initiate a new proxy request.
                    proxyRequest(req, res, proxy);
                    return false;
                }
            }
            proxyRes.headers.location = requestState.proxyBaseUrl + '/' + locationHeader;
        }
    }

    // Strip cookies
    delete proxyRes.headers['set-cookie'];
    delete proxyRes.headers['set-cookie2'];

    proxyRes.headers['x-final-url'] = requestState.location.href;
    withCORS(proxyRes.headers, req);
    return true;
}


/**
 * @param req_url {string} The requested URL (scheme is optional).
 * @return {object} URL parsed using url.parse
 */
function parseURL(req_url) {
    var match = req_url.match(/^(?:(https?:)?\/\/)?(([^\/?]+?)(?::(\d{0,5})(?=[\/?]|$))?)([\/?][\S\s]*|$)/i);
    //                              ^^^^^^^          ^^^^^^^^      ^^^^^^^                ^^^^^^^^^^^^
    //                            1:protocol       3:hostname     4:port                 5:path + query string
    //                                              ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //                                            2:host
    if (!match) {
        return null;
    }
    if (!match[1]) {
        if (/^https?:/i.test(req_url)) {
            // The pattern at top could mistakenly parse "http:///" as host="http:" and path=///.
            return null;
        }
        // Scheme is omitted.
        if (req_url.lastIndexOf('//', 0) === -1) {
            // "//" is omitted.
            req_url = '//' + req_url;
        }
        req_url = (match[4] === '443' ? 'https:' : 'http:') + req_url;
    }
    var parsed = url.parse(req_url);
    if (!parsed.hostname) {
        // "http://:1/" and "http:/notenoughslashes" could end up here.
        return null;
    }
    return parsed;
}

// Request handler factory
function getHandler(options, proxy) {
    var corsProksy = {
        handleInitialRequest: null,     // Function that may handle the request instead, by returning a truthy value.
        getProxyForUrl: getProxyForUrl, // Function that specifies the proxy to use
        maxRedirects: 5,                // Maximum number of redirects to be followed.
        redirectSameOrigin: false,      // Redirect the client to the requested URL for same-origin requests.
        requireHeader: null,            // Require a header to be set?
        removeHeaders: [],              // Strip these request headers.
        setHeaders: {},                 // Set these request headers.
        helpFile: './readme.md',
        corsMaxAge: 0,                  // If set, an Access-Control-Max-Age header with this value (in seconds) will be added.
    };

    Object.keys(corsProksy).forEach(function (option) {
        if (Object.prototype.hasOwnProperty.call(options, option)) {
            corsProksy[option] = options[option];
        }
    });

    // Convert corsProksy.requireHeader to an array of lowercase header names, or null.
    if (corsProksy.requireHeader) {
        if (typeof corsProksy.requireHeader === 'string') {
            corsProksy.requireHeader = [corsProksy.requireHeader.toLowerCase()];
        } else if (!Array.isArray(corsProksy.requireHeader) || corsProksy.requireHeader.length === 0) {
            corsProksy.requireHeader = null;
        } else {
            corsProksy.requireHeader = corsProksy.requireHeader.map(function (headerName) {
                return headerName.toLowerCase();
            });
        }
    }
    var hasRequiredHeaders = function (headers) {
        return !corsProksy.requireHeader || corsProksy.requireHeader.some(function (headerName) {
            return Object.hasOwnProperty.call(headers, headerName);
        });
    };

    return function (req, res) {
        req.corsProksyRequestState = {
            getProxyForUrl: corsProksy.getProxyForUrl,
            maxRedirects: corsProksy.maxRedirects,
            corsMaxAge: corsProksy.corsMaxAge,
        };

        var cors_headers = withCORS({}, req);
        if (req.method === 'OPTIONS') {
            // Pre-flight request. Reply successfully:
            res.writeHead(200, cors_headers);
            res.end();
            return;
        }

        var location = parseURL(req.url.slice(1));

        if (corsProksy.handleInitialRequest && corsProksy.handleInitialRequest(req, res, location)) {
            return;
        }

        if (!location) {
            if (/^\/https?:\/[^/]/i.test(req.url)) {
                res.writeHead(400, 'Missing slash', cors_headers);
                res.end('The URL is invalid: two slashes are needed after the http(s):.');
                return;
            }
            // Invalid API call. Show how to correctly use the API
            showUsage(corsProksy.helpFile, cors_headers, res);
            return;
        }

        if (location.host === 'iscorsneeded') {
            // Is CORS needed? This path is provided so that API consumers can test whether it's necessary
            // to use CORS. The server's reply is always No, because if they can read it, then CORS headers
            // are not necessary.
            res.writeHead(200, {'Content-Type': 'text/plain'});
            res.end('no');
            return;
        }

        if (location.port > 65535) {
            // Port is higher than 65535
            res.writeHead(400, 'Invalid port', cors_headers);
            res.end('Port number too large: ' + location.port);
            return;
        }

        if (!/^\/https?:/.test(req.url) && !isValidHostName(location.hostname)) {
            // Don't even try to proxy invalid hosts (such as /favicon.ico, /robots.txt)
            res.writeHead(404, 'Invalid host', cors_headers);
            res.end('Invalid host: ' + location.hostname);
            return;
        }

        if (!hasRequiredHeaders(req.headers)) {
            res.writeHead(400, 'Header required', cors_headers);
            res.end('Missing required request header. Must specify one of: ' + corsProksy.requireHeader);
            return;
        }

        var origin = req.headers.origin || '';

        if (corsProksy.redirectSameOrigin && origin && location.href[origin.length] === '/' &&
            location.href.lastIndexOf(origin, 0) === 0) {
            // Send a permanent redirect to offload the server. Badly coded clients should not waste our resources.
            cors_headers.vary = 'origin';
            cors_headers['cache-control'] = 'private';
            cors_headers.location = location.href;
            res.writeHead(301, 'Please use a direct request', cors_headers);
            res.end();
            return;
        }

        var isRequestedOverHttps = req.connection.encrypted || /^\s*https/.test(req.headers['x-forwarded-proto']);
        var proxyBaseUrl = (isRequestedOverHttps ? 'https://' : 'http://') + req.headers.host;

        corsProksy.removeHeaders.forEach(function (header) {
            delete req.headers[header];
        });

        Object.keys(corsProksy.setHeaders).forEach(function (header) {
            req.headers[header] = corsProksy.setHeaders[header];
        });

        req.corsProksyRequestState.location = location;
        req.corsProksyRequestState.proxyBaseUrl = proxyBaseUrl;

        proxyRequest(req, res, proxy);
    };
}

// Create server with default and given values
// Creator still needs to call .listen()
exports.createServer = function createServer(options) {
    options = options || {};

    // Default options:
    var httpProxyOptions = {
        xfwd: true,            // Append X-Forwarded-* headers
        secure: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
    };
    // Allow user to override defaults and add own options
    if (options.httpProxyOptions) {
        Object.keys(options.httpProxyOptions).forEach(function (option) {
            httpProxyOptions[option] = options.httpProxyOptions[option];
        });
    }

    var proxy = httpProxy.createServer(httpProxyOptions);
    var requestHandler = getHandler(options, proxy);
    var server;
    if (options.httpsOptions) {
        server = require('https').createServer(options.httpsOptions, requestHandler);
    } else {
        server = require('http').createServer(requestHandler);
    }

    // When the server fails, just show a 404 instead of Internal server error
    proxy.on('error', function (err, req, res) {
        if (res.headersSent) {
            if (res.writableEnded === false) {
                res.end();
            }
            return;
        }

        // When the error occurs after setting headers but before writing the response,
        // then any previously set headers must be removed.
        var headerNames = res.getHeaderNames ? res.getHeaderNames() : Object.keys(res._headers || {});
        headerNames.forEach(function (name) {
            res.removeHeader(name);
        });

        res.writeHead(404, {'Access-Control-Allow-Origin': '*'});
        res.end('Not found because of proxy error: ' + err);
    });

    return server;
};
