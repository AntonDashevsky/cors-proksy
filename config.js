exports.port = process.env.PORT || 8181;
exports.enable_logging = true;
exports.fetch_regex = /^\/(.*)$/; // The URL to look for when parsing the request.
exports.max_request_length = 100000; // The maximum length of characters allowed for a request or a response.
exports.cluster_process_count = Number(process.env.CLUSTER_PROCESS_COUNT) || require("os").cpus().length;
