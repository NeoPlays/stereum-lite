import log from "electron-log";

// Configure
log.transports.console.level = "info"; // Log only "info" or higher in console
log.transports.file.level = "debug";   // Log "debug" and higher in file

// Optional: Limit log file size & rotate
log.transports.file.maxSize = 1024 * 1024; // 1MB max log size
