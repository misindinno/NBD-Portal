// ─── WhatsAppService.js ──────────────────────────────────────────────────────
// Sends a WhatsApp notification (via the MessageAutoSender API) whenever the Stage
// Fields form saves a stage's custom fields for a lead. Message format mirrors the
// visit-form notifier: one "*Label-* value" line per field, files attached.

/******************** CONFIG ********************/

const WA_TIMEZONE = "Asia/Kolkata";

function _waConfig_() {
  const properties = PropertiesService.getScriptProperties();
  const config = {
    groupId: properties.getProperty('WA_GROUP_ID') || '',
    username: properties.getProperty('MAS_USERNAME') || '',
    password: properties.getProperty('MAS_PASSWORD') || '',
    apiKey: properties.getProperty('MAS_API_KEY') || ''
  };
  if (!config.groupId || !config.username || !config.password) {
    throw new Error('WhatsApp integration is not configured in Script Properties.');
  }
  return config;
}

/******************** STAGE FIELDS NOTIFICATION ********************/

// Called by saveLeadStageFields after a successful save. Never throws — a WhatsApp
// failure must not fail the save (the caller also wraps it defensively).
function sendStageFieldsWhatsApp_(lead, stageId, stageName, savedFields, user) {
  try {
    const now = new Date();
    const lines = [
      "*Date-* " + Utilities.formatDate(now, WA_TIMEZONE, "dd-MM-yyyy"),
      "*Time-* " + Utilities.formatDate(now, WA_TIMEZONE, "HH:mm"),
      "*Company-* " + (lead['Company Name'] || ""),
      "*Client Name-* " + (lead['Contact Person'] || ""),
      "*Contact No.-* " + (lead['Phone'] || ""),
      "*Stage-* " + (stageName || ""),
      "*Updated By-* " + ((user && (user.name || user.email || user.id)) || "")
    ];
    const fileUrls = [];

    // One line per custom field of this stage, in Display Order — same keys the form
    // saved (per-stage fields store under {columnKey}__{stageId}).
    getLeadCustomFieldsForStage(stageId).forEach(field => {
      if (field['Field Type'] === 'Formula') return;
      const isPerStage = (field['Per Stage'] === true || field['Per Stage'] === 'TRUE') && !field['Stage ID'];
      const key = isPerStage ? field['Column Key'] + '__' + stageId : field['Column Key'];
      if (!Object.prototype.hasOwnProperty.call(savedFields, key)) return;
      let value = savedFields[key];
      if (Array.isArray(value)) value = value.join(', ');
      value = value === undefined || value === null ? '' : String(value);
      lines.push("*" + (field['Field Name'] || key) + "-* " + value);
      if (field['Field Type'] === 'File') extractUrls_(value).forEach(u => fileUrls.push(u));
    });

    _masSendMessage_(_waConfig_().groupId, lines.join("\n"), fileUrls);
  } catch (err) {
    Logger.log("sendStageFieldsWhatsApp_ Error: " + err);
  }
}

/******************** VISIT REPORT NOTIFICATION ********************/

// Called by saveVisit after a successful save — visit-report message in the same
// format as the original visit notifier. Never throws.
function sendVisitWhatsApp_(lead, visitRow, savedFields, fields, user) {
  try {
    const now = new Date();
    const fileUrls = [];
    extractUrls_(visitRow['FEEDBACK ATTACHEMT'] || (savedFields || {})['FEEDBACK ATTACHEMT']).forEach(u => fileUrls.push(u));
    const lines = [
      "*Date-* " + (visitRow['DATE'] || visitRow['Visit Date'] || Utilities.formatDate(now, WA_TIMEZONE, "dd-MM-yyyy")),
      "*Time-* " + Utilities.formatDate(now, WA_TIMEZONE, "HH:mm"),
      "*Company-* " + (lead['Company Name'] || ""),
      "*Client Name-* " + (lead['Contact Person'] || ""),
      "*Contact No.-* " + (visitRow['CONTACT NO.'] || lead['Phone'] || ""),
      "*CITY-* " + (visitRow['CITY'] || lead['City'] || ""),
      "*ACCOMODATION TOUR-* " + (visitRow['ACCOMODATION TOUR'] || ""),
      "*ACCOMODATION STAY-* " + (visitRow['ACCOMODATION STAY'] || ""),
      "*AMOUNT-* " + (visitRow['AMOUNT'] || ""),
      "*LEADS-* " + (visitRow['LEADS'] || ""),
      "*source-* " + (visitRow['source'] || lead['Source'] || ""),
      "*FSR-* " + (visitRow['FSR'] || ""),
      "*SC-* " + (visitRow['SC'] || ""),
      "*VISIT-* " + (visitRow['VISIT'] || ""),
      "*designation-* " + (visitRow['designation'] || ""),
      "*CONVERSION-* " + (visitRow['CONVERSION'] || ""),
      "*FEEDBACK-* " + (visitRow['FEEDBACK'] || ""),
      "*Visited By-* " + ((user && (user.name || user.email || user.id)) || "")
    ];

    _masSendMessage_(_waConfig_().groupId, lines.join("\n"), fileUrls);
  } catch (err) {
    Logger.log("sendVisitWhatsApp_ Error: " + err);
  }
}

/******************** MESSAGE AUTO SENDER API ********************/

function _masSendMessage_(receivers, textMessages, filesUrls) {
  const config = _waConfig_();
  const messages = [].concat(textMessages || []);
  const urls = [].concat(filesUrls || []);
  const rawReceivers = [].concat(receivers || []);

  const receiverIds = rawReceivers.filter(item =>
    String(item).endsWith("@c.us") || String(item).endsWith("@g.us")
  );

  const receiverNumbers = rawReceivers.filter(item =>
    !receiverIds.includes(item)
  );

  const driveFiles = urls.filter(filePath =>
    String(filePath).indexOf("drive.google.com") !== -1 ||
    String(filePath).indexOf("docs.google.com") !== -1
  );

  const nonDriveFiles = urls.filter(filePath =>
    !driveFiles.includes(filePath)
  );

  const messageBody = {
    username: config.username,
    password: config.password,
    receiverMobileNo: receiverNumbers.join(","),
    recipientIds: receiverIds,
    message: messages,
    filePathUrl: nonDriveFiles,
    base64File: driveFiles.map(url => getGoogleFileAsBase64_(url)).filter(x => x && x.body)
  };

  const headers = {};

  if (config.username && config.password) {
    headers["Authorization"] =
      "Basic " + Utilities.base64Encode(config.username + ":" + config.password, Utilities.Charset.UTF_8);
  }

  if (config.apiKey) {
    headers["x-api-key"] = config.apiKey;
  }

  const options = {
    method: "post",
    contentType: "application/json",
    headers: headers,
    payload: JSON.stringify(messageBody),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(
      "https://app.messageautosender.com/api/v1/message/create",
      options
    );

    Logger.log("MAS Response Code: " + response.getResponseCode());
    Logger.log("MAS Response Body: " + response.getContentText());

    return response.getResponseCode() >= 200 && response.getResponseCode() < 300;

  } catch (err) {
    logServerError_(err, { operation: "whatsapp-send" });
    return false;
  }
}

/******************** GOOGLE DRIVE FILE TO BASE64 ********************/

function getGoogleFileAsBase64_(url) {
  try {
    const fileId = getDriveFileIdFromUrl_(url);
    if (!fileId) return {};

    // Google Docs links export as PDF via DriveApp (no DocumentApp — that would need
    // an extra OAuth scope the portals aren't authorized for).
    if (String(url).indexOf("docs.google.com") !== -1) {
      const file = DriveApp.getFileById(fileId);

      return {
        name: file.getName().replace(/\.[^/.]+$/, "") + ".pdf",
        body: Utilities.base64Encode(file.getAs("application/pdf").getBytes())
      };
    }

    if (String(url).indexOf("drive.google.com") !== -1) {
      const file = DriveApp.getFileById(fileId);

      return {
        name: file.getName(),
        body: Utilities.base64Encode(file.getBlob().getBytes())
      };
    }

    return {};

  } catch (err) {
    Logger.log("getGoogleFileAsBase64_ Error: " + err);
    return {};
  }
}

/******************** HELPERS ********************/

function getDriveFileIdFromUrl_(url) {
  const match = String(url || "").match(/[-\w]{25,}/);
  return match ? match[0] : "";
}

function extractUrls_(value) {
  if (!value) return [];

  return String(value)
    .split(/[\n, ]+/)
    .map(x => x.trim())
    .filter(x => x.indexOf("http") === 0);
}
