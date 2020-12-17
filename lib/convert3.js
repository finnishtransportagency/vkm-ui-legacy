const Promise = require("bluebird");
const rp = require("request-promise");
const xlsx = require("node-xlsx");
const R = require("ramda");

const API_URL = "https://julkinen.vayla.fi";
const VKM_URL = API_URL + "/vkm/muunnos";
const REVERSE_GEOCODE_URL = API_URL + "/vkm/reversegeocode";

const POINT_HEADERS = ["X", "Y", "Tie", "Ajorata", "Tieosa", "Etäisyys", "Katuosoite", "Kunta", "Ely", "Urakka alue"];
const POINT_DAYS_HEADERS = ["Tie", "Ajorata", "Tieosa", "Etäisyys", "Tilannepvm", "Kohdepvm", "Tie output", "Ajorata output", "Tieosa output", "Etäisyys output"];
const INTERVAL_HEADERS = ["Tie", "Ajorata", "Tieosa (alkupiste)", "Etäisyys (alkupiste)", "Tieosa (loppupiste)", "Etäisyys (loppupiste)", "AlkuX", "AlkuY", "LoppuX", "LoppuY"];
const ERROR_HEADER = "Virheviesti";

const COORDINATE_KEYS = ["x", "y"];
const ROAD_ADDRESS_KEYS = ["tie", "ajorata", "osa", "etaisyys"];
const ROAD_ADDRESS_KEYS_OUT = ["tie_out", "ajorata_out", "osa_out", "etaisyys_out"];
const STREET_ADDRESS_KEYS = ["osoite", "kunta"];
const OTHER_ADDRESS_KEYS = ["ely", "urakka_alue"];
const OTHER_DAYS_KEYS = ["tilannepvm","kohdepvm"];
const INTERVAL_ROAD_ADDRESS_KEYS = ["tie", "ajorata", "osa", "etaisyys", "losa", "let"];
const INTERVAL_COORDINATE_KEYS = ["alkux", "alkuy", "loppux", "loppuy"];
const EXTERNAL_ERROR_KEYS = ["palautusarvo", "virheteksti"];
const ERROR_KEYS = ["valid", "error"].concat(EXTERNAL_ERROR_KEYS);
const POINT_KEYS = COORDINATE_KEYS.concat(ROAD_ADDRESS_KEYS).concat(STREET_ADDRESS_KEYS).concat(OTHER_ADDRESS_KEYS);
const INTERVAL_KEYS = INTERVAL_ROAD_ADDRESS_KEYS.concat(INTERVAL_COORDINATE_KEYS);
const POINT_DAYS_KEYS = ROAD_ADDRESS_KEYS.concat(OTHER_DAYS_KEYS).concat(ROAD_ADDRESS_KEYS_OUT);
const OPTIONAL_INTERVAL_KEYS = ["ajorata"];

const LOCALIZED = {
  address: {
    plural: "tieosoitteet",
    singular: "tieosoite"
  },
  coordinate: {
    plural: "koordinaatit",
    singular: "koordinaatti"
  }
};

const MISSING_VALUE_ERROR = "Kohdetta ei löytynyt";

const CONCURRENT_REQUEST_LIMIT = 5;


//********** Level 1


exports.convert = function(buffer) {
  console.log('exports.convert');
  return parseInput(buffer)
    .then(validateValues)
    .then(convertValues)
    .then(buildOutput);
}


//********** Level 2


function parseInput(buffer) {
  //console.log('parseInput ' + parseInput.caller);
  console.log('parseInput');
  const parse = Promise.method(buffer => {
    const worksheet = xlsx.parse(buffer)[0];
    const table = worksheet.data;
    return { name: worksheet.name, header: headersToKeys(table[0]), values: parseTable(table) };
  });
  return parse(buffer).catch(_ => Promise.reject(Promise.OperationalError("Parsing input failed")));
}


function validateValues(data) {
  console.log('validateValues');
  const values = data.values;
  const type = determineType(data.header);
  const valid = x => !R.any(R.isNil, R.flatten(R.map(R.values, x)));
  const requiredValues = type === "intervalRoadAddress" ? R.map(R.omit(OPTIONAL_INTERVAL_KEYS), values) : values;

  if (valid(requiredValues)) {
    return R.merge(data, { type: type });
  } else {
    const validation = x => R.any(R.or(R.isNil, R.isEmpty), R.values(x));
    return Promise.reject(Promise.OperationalError(validationError(validation, requiredValues)));
  }
}


function convertValues(data) {
  console.log('convertValues');
  const resultByType = {
    coordinate: values => addRoadAddresses(values).then(addStreetAddresses),
    roadAddress: values => addCoordinates(values).then(addStreetAddresses),
    streetAddress: values => addGeocodedCoordinates(values).then(addRoadAddresses),
    intervalRoadAddress: values => addIntervalCoordinates(values),
    daysRoadAddress: values => addRoadAddressesWDays(values)
  };

  return resultByType[data.type](data.values).then(x => {
    return R.assoc("values", x, data);
  });
}


function buildOutput(data) {
  console.log('buildOutput');
  const interval = data.type === "intervalRoadAddress";
  const bydays = data.type === "daysRoadAddress";
  var keys;
  var headers;

  if(interval){
    keys = INTERVAL_KEYS;
    headers = INTERVAL_HEADERS;
  }else if(bydays){
    keys = POINT_DAYS_KEYS;
    headers = POINT_DAYS_HEADERS;
  }else{
    keys = POINT_KEYS;
    headers = POINT_HEADERS;
  }

  const values = data.values;
  const valuesOrderedByKeys = values.map(x => {
    const valueOrderedByKeys = keys.map(key => R.prop(key, x));
    return x.valid ? valueOrderedByKeys : valueOrderedByKeys.concat(x.error);
  });

  const metadata = getMetadata(values);
  const headerRow = metadata.errors ? headers.concat(ERROR_HEADER) : headers;
  const table = [headerRow].concat(valuesOrderedByKeys);

  return {
    xlsx: xlsx.build([{name: data.fileName, data: table }]),
    metadata: metadata
  };
}


//********** Level 3


function headersToKeys(headerRow) { //*** Level 5 too
  console.log('headersToKeys');
  const headers = R.reject(R.isEmpty, headerRow);
  const allKeys = POINT_KEYS.concat(INTERVAL_KEYS).concat(POINT_DAYS_KEYS);
  const allHeaders = POINT_HEADERS.concat(INTERVAL_HEADERS).concat(POINT_DAYS_HEADERS);
  return R.map(x => allKeys[allHeaders.indexOf(x)], headers);
}


function parseTable(values) {
  console.log('parseTable');
  const header = values[0] || [];
  const headerConsistsOf = a => R.all(x => R.contains(x, a), header);
  const headerIsValid = headerConsistsOf(POINT_HEADERS) || headerConsistsOf(POINT_DAYS_HEADERS) || headerConsistsOf(INTERVAL_HEADERS);

  if (headerIsValid) {
    const onlyNonEmptyRows = R.reject(R.all(R.isEmpty));
    return tableToObjects(onlyNonEmptyRows(values));
  } else {
    throw Promise.OperationalError("You must specity a header");
  }
}


function determineType(headerKeys) {
  console.log('determineType');
  const headersEqual = R.equals(headerKeys);
  if (headersEqual(COORDINATE_KEYS)) return "coordinate";
  if (headersEqual(ROAD_ADDRESS_KEYS)) return "roadAddress";
  if (headersEqual(INTERVAL_ROAD_ADDRESS_KEYS)) return "intervalRoadAddress";
  if (headersEqual(ROAD_ADDRESS_KEYS.concat(OTHER_DAYS_KEYS))) return "daysRoadAddress";
  throw Promise.OperationalError("You must specity a header");
}


function addCoordinates(addresses) {
  console.log('addCoordinates');
  return decorateWith(LOCALIZED.address, LOCALIZED.coordinate, addresses, COORDINATE_KEYS);
}


function addStreetAddresses(values) {
  console.log('addStreetAddresses');
  const reverseGeocode = value => httpGet(REVERSE_GEOCODE_URL, R.pick(COORDINATE_KEYS, value));
  return Promise.map(values, reverseGeocode, { concurrency: CONCURRENT_REQUEST_LIMIT })
    .map(R.pick(STREET_ADDRESS_KEYS.concat(OTHER_ADDRESS_KEYS)))
    .then(mergeAllWith(values));
}


function getMetadata(data) {
  console.log('getMetadata');
  const notValid = R.compose(R.not, R.prop("valid"));
  if (R.any(notValid, data)) {
    return validationError(notValid, data);
  } else {
    return { errors: false };
  }
}


//********** Level 4


function tableToObjects(table) {
  console.log('tableToObjects');
  const headers = R.head(table);
  const content = R.tail(table);
  return R.map(R.zipObj(headersToKeys(headers)), content);
}


function decorateWith(inputType, outputType, values, whitelistedKeys) {
  console.log('decorateWith');
  const payload = {};
  payload[inputType.plural] = values;
  const data = {
    in: inputType.singular,
    out: outputType.singular,
    callback: null,
    kohdepvm: null,
    json: JSON.stringify(payload)
  };
  return httpPost(VKM_URL, data).then(R.pipe(
        R.propOr(values, outputType.plural),
        R.map(R.pick(whitelistedKeys.concat(ERROR_KEYS))),
        mergeAllWith(values),
        R.map(validate)));
}


function httpGet(url, params) {
  console.log('httpGet');
  return rp({ url: url, qs: params }).then(parseJSON);
}


function mergeAllWith(xs) {//*** Level 5 too
  console.log('mergeAllWith');
  const defaults = R.flip(R.merge);
  return R.zipWith(defaults, xs);
}


//********** Level 5


function httpPost(url, params) {
  console.log('httpPost');
  return rp.post({
    url: url,
    form: params,
    encoding: "utf-8",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }
  }).then(parseJSON);
}


function validate(x) {
  console.log('validate');
  if (R.has("valid", x)) return x;
  const validationStatus = x.palautusarvo === 1 ?
    { valid: true } :
    { valid: false, error: x.virheteksti || MISSING_VALUE_ERROR };
  return R.merge(R.omit(EXTERNAL_ERROR_KEYS, x), validationStatus);
}


function parseJSON(str) {//*** Level 6 too
  console.log('parseJSON');
  return str.trim() ? JSON.parse(str) : {};
}


//********** Needed


function validationError(validationFn, data) {
  console.log('validationError');
  const rowOffset = 2;
  return {
    errors: true,
    errorCount: R.filter(validationFn, data).length,
    firstError: R.findIndex(validationFn, data) + rowOffset
  };
}