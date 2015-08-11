const express = require("express");
const multer  = require("multer");
const streamifier = require("streamifier");
const R = require("ramda");

const frameOfReferenceConverter = require("./convert.js");

const CACHE_EXPIRATION_TIMEOUT = 60 * 60 * 1000;

const app = express();
const server = app.listen(3000);

app.locals.files = {};

app.get("/", function(req, res) {
  res.sendFile(__dirname + "/client.html");
});
app.use("/bower_components", express.static("bower_components"));
app.use("/excel_templates", express.static("excel_templates"));
app.use("/static", express.static("static"));

app.post("/upload", multer({
  inMemory: true,
  onFileUploadComplete: function(file, req, res) {
    const promisedFile = frameOfReferenceConverter.convert(file.buffer)
      .then(data => ({
        name: file.originalname,
        mimetype: file.mimetype,
        buffer: data.xlsx,
        metadata: data.metadata }))
      .catch(e => console.log(e));
    app.locals.files[file.name] = promisedFile;
    res.end(file.name, "utf-8");
    promisedFile.delay(CACHE_EXPIRATION_TIMEOUT)
      .finally(() => { delete app.locals.files[file.name]; });
  }
}));

app.get("/status/:fileName", function(req, res) {
  const fileName = req.params.fileName;

  ifFileStatus(fileName, {
    ready: (file) => res.json(file.metadata),
    pending: () => res.sendStatus(202),
    error: () => res.sendStatus(500),
    notFound: () => res.sendStatus(404)
  });
})

app.get("/download/:fileName", function(req, res) {
  const fileName = req.params.fileName;
  ifFileStatus(fileName, {
    ready: (file) => {
      res.setHeader("Content-disposition", "attachment; filename=" + file.name);
      res.setHeader("Content-type", file.mimetype);

      streamifier.createReadStream(file.buffer).pipe(res);
    },
    pending: () => res.end("Ladataan...", "utf-8"),
    error: () => res.sendStatus(500),
    notFound: () => res.sendStatus(404)
  });
});

function ifFileStatus(fileName, callbacks) {
  if (R.has(fileName, app.locals.files)) {
    const promisedFile = app.locals.files[fileName];
    if (promisedFile.isFulfilled() && promisedFile.value()) { callbacks.ready(promisedFile.value()); }
    else if (promisedFile.isPending()) { callbacks.pending() }
    else { callbacks.error(); }
  } else {
    callbacks.notFound();
  }
}
