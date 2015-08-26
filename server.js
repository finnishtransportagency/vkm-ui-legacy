const express = require("express");
const multer  = require("multer");
const streamifier = require("streamifier");
const R = require("ramda");
const errors = require('request-promise/errors');

const converter = require("./lib/convert.js");

const CACHE_EXPIRATION_TIMEOUT = 60 * 60 * 1000;

const app = express();
const port = process.env.VKM_PORT || 3000;
const server = app.listen(port, () => console.log("Started at port " + port));

app.locals.files = {};

app.use("/", express.static("public"));
app.use("/bower_components", express.static("bower_components"));
app.use("/excel_templates", express.static("excel_templates"));

app.post("/upload", multer({
  inMemory: true,
  onFileUploadComplete: function(file, req, res) {
    const promisedFile = converter.convert(file.buffer)
      .then(data => ({
        valid: true,
        name: file.originalname,
        mimetype: file.mimetype,
        buffer: data.xlsx,
        metadata: data.metadata }))
      .catch(errors.RequestError, e => ({ valid: false, reason: errors.RequestError }))
      .error(e => ({ valid: false, reason: converter.ParseError, metadata: e }))
      .catch(e => ({ valid: false }));

    app.locals.files[file.name] = promisedFile;
    res.end(file.name, "utf-8");
    promisedFile.delay(CACHE_EXPIRATION_TIMEOUT)
      .finally(() => { delete app.locals.files[file.name]; });
  }
}));

app.get("/status/:fileName", function(req, res) {
  doByFileStatus(req.params.fileName, {
    ready: (file) => res.json(file.metadata),
    pending: () => res.sendStatus(202),
    error: () => res.sendStatus(500),
    badRequest: (file) => res.status(400).json(file.metadata),
    notFound: () => res.sendStatus(404)
  });
});

app.get("/download/:fileName", function(req, res) {
  doByFileStatus(req.params.fileName, {
    ready: (file) => {
      res.setHeader("Content-disposition", "attachment; filename=" + file.name);
      res.setHeader("Content-type", file.mimetype);

      streamifier.createReadStream(file.buffer).pipe(res);
    },
    pending: () => res.end("Ladataan...", "utf-8"),
    error: () => res.sendStatus(500),
    badRequest: () => res.sendStatus(400),
    notFound: () => res.sendStatus(404)
  });
});

function doByFileStatus(fileName, operationsByStatus) {
  const obj = getFile(fileName);
  const operation = operationsByStatus[obj.status];
  operation(obj.file);
}

function getFile(fileName) {
  if (R.has(fileName, app.locals.files)) {
    return tryToUnwrapFile(app.locals.files[fileName]);
  } else {
    return { status: "notFound" };
  }
}

function tryToUnwrapFile(promisedFile) {
  if (promisedFile.isFulfilled()) {
    return unwrapFile(promisedFile.value());
  } else if (promisedFile.isPending()) {
    return { status: "pending" };
  } else {
    return { status: "error" };
  }
}

function unwrapFile(file) {
  if (file.valid) {
    return { status: "ready", file: file };
  } else if (file.reason === converter.ParseError) {
    return { status: "badRequest", file: file };
  } else {
    return { status: "error" };
  }
}
