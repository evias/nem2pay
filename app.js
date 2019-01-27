#!/usr/bin/nodejs

/**
 * Part of the evias/nem2pay package.
 *
 * NOTICE OF LICENSE
 *
 * Licensed under MIT License.
 *
 * This source file is subject to the MIT License that is
 * bundled with this package in the LICENSE file.
 *
 * @package    evias/nem2pay
 * @author     Grégory Saive <greg@evias.be>
 * @license    MIT License
 * @copyright  (c) 2019, Grégory Saive <greg@evias.be>
 * @link       http://github.com/evias/nem2pay
 */

var app = require('express')(),
    server = require('http').createServer(app),
    io = require('socket.io').listen(server),
    path = require('path'),
    handlebars = require("handlebars"),
    expressHbs = require("express-handlebars"),
    mongoose = require("mongoose"),
    bodyParser = require("body-parser"),
    config = require("config"),
    nem = require("nem-sdk").default,
    i18n = require("i18next"),
    i18nFileSystemBackend = require('i18next-node-fs-backend'),
    i18nMiddleware = require('i18next-express-middleware'),
    fs = require("fs"),
    flash = require("connect-flash"),
    session = require("express-session"),
    validator = require("express-validator");

// internal core dependencies
var logger = require('./core/logger.js');
var __smartfilename = path.basename(__filename);

var serverLog = function(req, msg, type) {
    var logMsg = "[" + type + "] " + msg + " (" + (req.headers ? req.headers['x-forwarded-for'] : "?") + " - " +
        (req.connection ? req.connection.remoteAddress : "?") + " - " +
        (req.socket ? req.socket.remoteAddress : "?") + " - " +
        (req.connection && req.connection.socket ? req.connection.socket.remoteAddress : "?") + ")";
    logger.info(__smartfilename, __line, logMsg);
};

// configure view engine (handlebars)
app.engine(".hbs", expressHbs({
    extname: ".hbs",
    defaultLayout: "default.hbs",
    layoutPath: "views/layouts"
}));
app.set("view engine", "hbs");

// configure translations with i18next
i18n.use(i18nFileSystemBackend)
    .init({
        lng: "en",
        fallbackLng: "en",
        defaultNS: "translation",
        whitelist: ["en", "de", "fr"],
        nonExplicitWhitelist: true,
        preload: ["en", "de", "fr"],
        backend: {
            loadPath: "locales/{{lng}}/{{ns}}.json"
        }
    });

// configure body-parser usage for POST API calls.
app.use(bodyParser.urlencoded({ extended: true }));

/**
 * Configure Express Application Middlewares:
 * - flash (connect-flash) notifications helper
 * - session (express-session)
 * - validator (express-validator)
 *
 * Used for Notifications across the game, input validation
 * and cross-request messages.
 */
app.configure(function() {
    app.use(session({
        cookie: { maxAge: 60000 },
        secret: config.get("payments.secretKey"),
        resave: false,
        saveUninitialized: false
    }));

    app.use(flash());
    app.use(validator());

    // LOCALES MANAGEMENT in frontend
    app.use(function(req, res, next) {
        req.i18n = i18n;

        if (req.session.locale) // check if user has changed i18n settings
            req.i18n.changeLanguage(req.session.locale);

        next();
    });

    // Cache for Frontend Static Assets (2 Days)
    app.use(function(req, res, next) {
        var oneDay = 86400000;

        if (req.url.match(/\.(css|js|png|jpg|gif|svg|ttf|woff)$/)) {
            res.setHeader('Cache-Control', 'public, max-age=' + (oneDay * 2));
        }
        next();
    });
});
/**
 * End Application Middlewares
 */

// redirect to canonical URL
app.get('/*', function(req, res, next) {
    var protocol = 'http' + (req.connection.encrypted ? 's' : '') + '://',
        host = req.headers.host,
        href;

    var canonicalUrl = config.get("canonicalUrl", "nem2pay.evias.be");
    var canonicalUrlReg = new RegExp();
    if (!canonicalUrlReg.test(req.headers.host)) {
        var newHost = protocol + canonicalUrl;

        res.statusCode = 301;
        res.setHeader("Location", newHost);
        res.write("Redirecting to " + newHost);
        return res.end();
    }
    else {
        return next();
    }
});

/**
 * Configure the NEM2Pay Backend Modules. This includes following:
 * 
 * - NEMHelpers : defines general blockchain config (hosts, wallets)
 * - PaymentsDatabase : MongoDB (mongoose) wrapper for the PacNEM backend
 * - PaymentsProtocol : The Payment Protocol defines how to handle Invoices
 * - PacNEM_Crons : Define workers for the PacNEM Backend
 */
// configure blockchain layer
var helpers = require('./core/helpers.js').service;
var NEMHelpers = new helpers(io, nem, logger);

// configure database layer
var DBStore = require('./core/database.js').DBStore;
var PaymentsDatabase = new DBStore(io, NEMHelpers);

// configure our PaymentsCore implementation, handling payment
// processor and NEMBot communication
var Protocol = require("./core/payments-protocol.js").PaymentsProtocol;
var PaymentsProtocol = new Protocol(io, logger, NEMHelpers, PaymentsDatabase);

var NEM2Pay_i18n = function() {
    this.getLocales = function() {
        var paths = {
            "en": __dirname + '/locales/en/translation.json',
            "de": __dirname + '/locales/de/translation.json',
            "fr": __dirname + '/locales/fr/translation.json'
        };

        var locales = { "en": {}, "de": {}, "fr": {} };
        for (var lang in paths) {
            var json = fs.readFileSync(paths[lang]);
            locales[lang] = JSON.parse(json);
        }

        return locales;
    };
};

var NEM2Pay_Frontend_Config = {
    "dataSalt": config.get("payments.secretKey"),
    "localesJSON": JSON.stringify((new NEM2Pay_i18n()).getLocales()).replace(/'/g, "\\'")
};

/**
 * Serving static Assets (images, CSS, JS files)
 * @param {*} req 
 * @param {*} res 
 */
var serveStaticFile = function(req, res, path) {
    var file = req.params ? req.params[0] : "";
    if (!file.length)
        return res.send(404);

    // make sure file exists
    var path = __dirname + path + file;
    if (!fs.existsSync(path)) {
        return res.send(404);
    }

    return res.sendfile(path);
};

/**
 * View Engine Customization
 *
 * - handlebars t() helper for template translations handling with i18next
 **/
handlebars.registerHelper('t', function(key, sub) {
    if (typeof sub != "undefined" && sub !== undefined && typeof sub === "string" && sub.length)
    // dynamic subnamespace
        var key = key + "." + sub;

    return new handlebars.SafeString(i18n.t(key));
});

/**
 * Handlebars counter() helper implementation for frontend
 * templates
 */
handlebars.registerHelper("time", function() {
    return new handlebars.SafeString("" + new Date().valueOf());
});

/**
 * Third Party static asset serving
 * - Bootstrap
 * - Handlebars
 * - i18next
 * - jQuery
 */
app.get('/3rdparty/*', function(req, res) {
    return serveStaticFile(req, res, "/www/3rdparty/");
});
app.get('/img/*', function(req, res) {
    return serveStaticFile(req, res, "/img/");
});
app.get('/css/*', function(req, res) {
    return serveStaticFile(req, res, "/www/css/");
});
app.get('/js/*', function(req, res) {
    return serveStaticFile(req, res, "/www/js/");
});

// SSL Certificate Verification
app.get('/.well-known/acme-challenge/*', function(req, res) {
    return serveStaticFile(req, res, "/www/ssl-verification/");
});

/**
 * Static Files (assets) Serving
 *
 * Also includes asynchronously loaded templates,
 * those are stored in views/partials/*.hbs files.
 */
app.get('/favicon.ico', function(req, res) {
    res.sendfile(__dirname + '/www/favicon.ico');
});
app.get('/robots.txt', function(req, res) {
    res.sendfile(__dirname + '/www/robots.txt');
});

app.get("/", function(req, res) {
    var currentLanguage = req.i18n.language;
    var currentNetwork = NEMHelpers.getNetwork();

    var notificationMessage = typeof flash("info") == "undefined" ? "" : req.flash("info");

    var viewData = {
        currentNetwork: currentNetwork,
        currentLanguage: currentLanguage,
        NEM2Pay_Frontend_Config: NEM2Pay_Frontend_Config,
        notificationMessage: notificationMessage,
        isFacebookCanvas: false
    };

    res.render("play", viewData);
});

// change language fake middleware
app.get("/:lang", function(req, res) {
    var currentLanguage = req.params.lang;

    var validLang = { "en": true, "de": true, "fr": true };
    if (!validLang.hasOwnProperty(currentLanguage))
        currentLanguage = "en";

    var currentNetwork = NEMHelpers.getNetwork();

    req.session.locale = currentLanguage;
    if (req.headers.referer)
        return res.redirect(req.headers.referer);

    return res.redirect("/");
});

/**
 * API Routes
 *
 * Following routes are used for handling the business/data
 * layer.
 *
 * All API routes are prefixed by `/api/v1` currently. Following
 * API routes are defined by PacNEM:
 * 
 * - GET /invoices/create : Create Invoice for Frontend
 * - GET /invoices/history : View Invoice History (or Single Invoice)
 * 
 */

app.get("/api/v1/invoices/create", function(req, res) {
    res.setHeader('Content-Type', 'application/json');

    var amount = parseFloat(config.get("prices.entry"));

    var clientSocketId = req.query.usid ? req.query.usid : null;
    if (!clientSocketId || !clientSocketId.length)
        return res.send(JSON.stringify({ "status": "error", "message": "Mandatory field `Client Socket ID` is invalid." }));

    var invoiceNumber = req.query.num ? req.query.num : null;

    var payer = req.query.payer ? req.query.payer : undefined;
    if (!payer.length || NEMHelpers.isApplicationWallet(payer))
    // cannot be one of the application wallets
        return res.send(JSON.stringify({ "status": "error", "message": "Invalid value for field `payer`." }));

    var recipient = req.query.recipient ? req.query.recipient : config.get("pacnem.business"); // the App's MultiSig wallet
    if (!recipient.length || !NEMHelpers.isApplicationWallet(recipient))
    // must be one of the application wallets
        return res.send(JSON.stringify({ "status": "error", "message": "Invalid value for field `recipient`." }));

    var heartPrice = parseFloat(config.get("prices.heart")); // in XEM
    var receivingHearts = Math.ceil(amount * heartPrice); // XEM price * (1 Heart / x XEM)
    var invoiceAmount = amount * 1000000; // convert amount to micro XEM
    var currentNetwork = NEMHelpers.getNetwork();
    var disableChannel = req.query.chan ? req.query.chan == "0" : false;

    var dbConditions = {
        payerXEM: payer,
        recipientXEM: recipient
    };

    // when no invoiceNumber is given, create or retrieve in following statuses
    dbConditions["status"] = { $in: ["not_paid", "identified", "unconfirmed", "paid_partly", "paid"] };
    if (invoiceNumber && invoiceNumber.length) {
        // load invoice by number
        dbConditions["number"] = decodeURIComponent(invoiceNumber);
        delete dbConditions["status"];
    }

    //serverLog("DEBUG", JSON.stringify(dbConditions), "DEBUG");

    // mongoDB model NEMPaymentChannel unique on xem address + message pair.
    PaymentsDatabase.NEMPaymentChannel.findOne(dbConditions, function(err, invoice) {
        if (!err && !invoice) {
            // creation mode

            var invoice = new PaymentsDatabase.NEMPaymentChannel({
                recipientXEM: recipient,
                payerXEM: payer,
                amount: invoiceAmount,
                amountPaid: 0,
                amountUnconfirmed: 0,
                status: "not_paid",
                countHearts: receivingHearts,
                createdAt: new Date().valueOf()
            });
            invoice.save(function(err) {
                return PaymentsProtocol.startPaymentChannel(invoice, clientSocketId, function(invoice) {
                    // payment channel created, end create-invoice response.

                    var statusLabelClass = "label-default";
                    var statusLabelIcon = "glyphicon glyphicon-time";

                    if (invoice.isPaid) {
                        statusLabelClass = "label-success";
                        statusLabelIcon = "glyphicon glyphicon-ok";
                    } else if (invoice.status == "paid_partly") {
                        statusLabelClass = "label-info";
                        statusLabelIcon = "glyphicon glyphicon-download-alt";
                    }

                    res.send(JSON.stringify({
                        status: "ok",
                        item: {
                            network: currentNetwork,
                            qrData: invoice.getQRData(),
                            invoice: invoice,
                            statusLabelClass: statusLabelClass,
                            statusLabelIcon: statusLabelIcon
                        }
                    }));
                });
            });

            return false;
        } else if (err) {
            // error mode
            var errorMessage = "Error occured on NEMPaymentChannel update: " + err;

            serverLog(req, errorMessage, "ERROR");
            return res.send(JSON.stringify({ "status": "error", "message": errorMessage }));
        }

        // update mode, invoice already exists, create payment channel proxy

        var statusLabelClass = "label-default";
        var statusLabelIcon = "glyphicon glyphicon-time";

        if (invoice.isPaid) {
            statusLabelClass = "label-success";
            statusLabelIcon = "glyphicon glyphicon-ok";
        } else if (invoice.status == "paid_partly") {
            statusLabelClass = "label-info";
            statusLabelIcon = "glyphicon glyphicon-download-alt";
        }

        if (disableChannel === true) {
            return res.send(JSON.stringify({
                status: "ok",
                item: {
                    network: currentNetwork,
                    qrData: invoice.getQRData(),
                    invoice: invoice,
                    statusLabelClass: statusLabelClass,
                    statusLabelIcon: statusLabelIcon
                }
            }));
        } else {
            return PaymentsProtocol.startPaymentChannel(invoice, clientSocketId, function(invoice) {
                // payment channel created, end create-invoice response.

                res.send(JSON.stringify({
                    status: "ok",
                    item: {
                        network: currentNetwork,
                        qrData: invoice.getQRData(),
                        invoice: invoice,
                        statusLabelClass: statusLabelClass,
                        statusLabelIcon: statusLabelIcon
                    }
                }));
            });
        }
    });
});

app.get("/api/v1/invoices/history", function(req, res) {
    res.setHeader('Content-Type', 'application/json');

    var payer = req.query.payer ? req.query.payer : undefined;
    var number = req.query.number ? req.query.number : undefined;

    if (!payer || !payer.length || NEMHelpers.isApplicationWallet(payer))
    // cannot be one of the application wallets
        return res.send(JSON.stringify({ "status": "error", "message": "Invalid value for field `payer`." }));

    var invoiceQuery = {
        payerXEM: payer,
        status: {
            $in: ["not_paid",
                "expired",
                "unconfirmed",
                "paid_partly",
                "paid"
            ]
        }
    };

    if (number && number.length) {
        invoiceQuery["number"] = number;
    }

    PaymentsDatabase.NEMPaymentChannel.find(invoiceQuery, function(err, invoices) {
        if (err) {
            var errorMessage = "Error occured on /credits/history: " + err;
            serverLog(req, errorMessage, "ERROR");
            return res.send(JSON.stringify({ "status": "error", "message": errorMessage }));
        }

        if (!invoices || !invoices.length)
            return res.send(JSON.stringify({ "status": "ok", data: [] }));

        // VERIFY all invoices state and amounts by iterating blockchain
        // transactions. This ensure that we never send a wrong Invoice State
        // through this API - it will always be validated by blockchain data.
        PaymentsProtocol.fetchInvoicesRealHistory(invoices, null, function(invoicesHistory) {
            if (invoicesHistory === false)
                return res.send(JSON.stringify({ "status": "ok", data: [] }));

            // return list of invoices
            var invoicesData = [];
            for (var num in invoicesHistory) {
                var currentInvoice = invoicesHistory[num].invoice;

                var statusLabelClass = "label-default";
                var statusLabelIcon = "glyphicon glyphicon-time";

                if (currentInvoice.isPaid) {
                    statusLabelClass = "label-success";
                    statusLabelIcon = "glyphicon glyphicon-ok";
                } else if (currentInvoice.status == "paid_partly") {
                    statusLabelClass = "label-info";
                    statusLabelIcon = "glyphicon glyphicon-download-alt";
                }

                var fmtCreatedAt = new Date(currentInvoice.createdAt).toISOString().replace(/T/, ' ').replace(/\..+/, '');
                var fmtUpdatedAt = new Date(currentInvoice.createdAt).toISOString().replace(/T/, ' ').replace(/\..+/, '');

                invoicesData.push({
                    number: currentInvoice.number,
                    recipient: currentInvoice.recipientXEM,
                    truncRecipient: currentInvoice.getTruncatedRecipient(),
                    amount: (currentInvoice.amount),
                    amountPaid: (currentInvoice.amountPaid),
                    amountFmt: (currentInvoice.amount / Math.pow(10, 6)),
                    amountPaidFmt: (currentInvoice.amountPaid / Math.pow(10, 6)),
                    status: currentInvoice.status,
                    createdAt: fmtCreatedAt,
                    updatedAt: fmtUpdatedAt,
                    statusLabelClass: statusLabelClass,
                    statusLabelIcon: statusLabelIcon
                });
            }

            if (number && number.length && invoicesData.length === 1)
            // single invoice data
                return res.send(JSON.stringify({ "status": "ok", item: invoicesData.pop() }));

            return res.send(JSON.stringify({ "status": "ok", data: invoicesData }));
        });
    });
});

app.get("/api/v1/reset", function(req, res) {
    res.setHeader('Content-Type', 'application/json');

    var canResetData = process.env["ALLOW_DB_RESET"] == 1 || config.get("pacnem.canResetData", false);
    if (!canResetData || canResetData !== true)
        return res.send(JSON.stringify({ "status": "error", "error": "Feature disabled" }));

    // remove all data..
    PaymentsDatabase.NEMPaymentChannel.find({}).remove(function(err) {});
    return res.send(JSON.stringify({ "status": "ok" }));
});

/**
 * Now listen for connections on the Web Server.
 *
 * This starts the NodeJS server and makes the Game
 * available from the Browser.
 */
var port = process.env['PORT'] = process.env.PORT || 2908;
server.listen(port, function() {
    var network = NEMHelpers.getNetwork();
    var blockchain = network.isTest ? "Testnet Blockchain" : network.isMijin ? "Mijin Private Blockchain" : "NEM Mainnet Public Blockchain";
    var currency = NEMHelpers.getCurrency();

    console.log("------------------------------------------------------------------------");
    console.log("--                   NEM2Pay Payment Processor                        --");
    console.log("--                                                                    --");
    console.log("--           Payment Processor using the NEM Blockchain               --")
    console.log("------------------------------------------------------------------------");
    console.log("-");
    console.log("- NEM2Pay Server listening on Port %d in %s mode", this.address().port, app.settings.env);
    console.log("- NEM2Pay is using blockchain: " + blockchain);
    console.log("- NEM2Pay is using Currency: " + currency);
    console.log("-")
    console.log("------------------------------------------------------------------------");
});