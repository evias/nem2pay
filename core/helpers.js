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
 * @author     Grégory Saive <greg@evias.be> (https://github.com/evias)
 * @license    MIT License
 * @copyright  (c) 2019, Grégory Saive <greg@evias.be>
 * @link       https://github.com/evias/nem2pay
 */

(function() {

    var config = require("config"),
        CryptoJS = require("crypto-js");

    /**
     * class service provides a business layer for
     * CORE data queries used in the NEM2Pay application.
     *
     * @author  Grégory Saive <greg@evias.be> (https://github.com/evias)
     */
    var service = function(io, nemSDK, logger) {
        var socket_ = io;
        var nem_ = nemSDK;
        var logger_ = logger;

        // connect to the CORE with the NEM SDK
        var nemHost = process.env["NEM_HOST"] || config.get("nem.nodes")[0].host;
        var nemPort = process.env["NEM_PORT"] || config.get("nem.nodes")[0].port;
        var node_ = nem_.model.objects.create("endpoint")(nemHost, nemPort);

        /**
         * Get the NEM Currency used for this application.
         *
         * @return string   The namespace + subnamespace(s) joined with a dot (.).
         */
        this.getCurrency = function() {
            return process.env["APP_CURRENCY"] || config.get("payments.currency");
        };

        /**
         * Get the NEM-sdk object initialized before.
         * 
         * @link https://github.com/QuantumMechanics/NEM-sdk
         */
        this.getSDK = function() {
            return nem_;
        };

        /**
         * Get the NEM-sdk `endpoint` with which we are connecting
         * to the CORE.
         */
        this.getEndpoint = function() {
            return node_;
        };

        /**
         * This method returns a SALT. The salt is used to improve the random
         * attributes of wallet generation.
         *
         * @return {string}
         */
        this.getWalletSalt = function() {
            return process.env["WALLET_SALT"] || config.get("payments.walletSalt");
        };

        /**
         * This returns the `payments.secretKey` config value.
         * 
         * This key can be changed to make the application act
         * privately on the CORE
         * 
         * @return {string}
         */
        this.getEncryptionSecretKey = function() {
            return config.get("payments.secretKey");
        };

        /**
         * Get the Network details. This will return the currently
         * used config for the NEM node (endpoint).
         *
         * @return Object
         */
        this.getNetwork = function() {
            var isMijin = config.get("nem.isMijin");

            return {
                "host": node_.host,
                "port": node_.port,
                "label": isMijin ? "Mijin" : "Mainnet",
                "config": isMijin ? nem_.model.network.data.mijin : nem_.model.network.data.mainnet,
                "isMijin": isMijin
            };
        };

        /**
         * Get the status of the currently select NEM CORE node.
         *
         * @return Promise
         */
        this.heartbeat = function() {
            return nem_.com.requests.endpoint.heartbeat(node_);
        };

        /**
         * Read the Transaction Hash from a given TransactionMetaDataPair
         * object (gotten from NEM websockets or API).
         *
         * @param  [TransactionMetaDataPair]{@link http://bob.nem.ninja/docs/#transactionMetaDataPair} transactionMetaDataPair
         * @return {string}
         */
        this.getTransactionHash = function(transactionMetaDataPair, inner = false) {
            var meta = transactionMetaDataPair.meta;
            var content = transactionMetaDataPair.transaction;

            var trxHash = meta.hash.data;
            if (inner === true && meta.innerHash.data && meta.innerHash.data.length)
                trxHash = meta.innerHash.data;

            return trxHash;
        };

        /**
         * Read CORE transaction ID from TransactionMetaDataPair
         *
         * @param  [TransactionMetaDataPair]{@link http://bob.nem.ninja/docs/#transactionMetaDataPair} transactionMetaDataPair
         * @return {integer}
         */
        this.getTransactionId = function(transactionMetaDataPair) {
            return transactionMetaDataPair.meta.id;
        };

        /**
         * Read CORE transaction Message from TransactionMetaDataPair
         *
         * @param  [TransactionMetaDataPair]{@link http://bob.nem.ninja/docs/#transactionMetaDataPair} transactionMetaDataPair
         * @return {string}
         */
        this.getTransactionMessage = function(transactionMetaDataPair, doDecrypt = false) {
            var meta = transactionMetaDataPair.meta;
            var content = transactionMetaDataPair.transaction;

            var trxRealData = content;
            if (content.type == nem_.model.transactionTypes.multisigTransaction) {
                // multisig, message will be in otherTrans
                trxRealData = content.otherTrans;
            }

            if (!trxRealData.message || !trxRealData.message.payload)
            // no message found in transaction
                return "";

            //DEBUG logger_.info("[DEBUG]", "[CORE]", "Reading following message: " + JSON.stringify(trxRealData.message));

            // decode transaction message and job done
            var payload = trxRealData.message.payload;
            var plain = nem_.utils.convert.hex2a(payload);

            //DEBUG logger_.info("[DEBUG]", "[CORE]", "Message Read: " + JSON.stringify(plain));

            if (doDecrypt === true) {
                var decrypted = CryptoJS.AES.decrypt(plain, this.getEncryptionSecretKey());

                //DEBUG logger_.info("[DEBUG]", "[CORE]", "Decrypted using AES from '" + plain + "' to '" + decrypted + "'");

                return decrypted;
            }

            return plain;
        };

        /**
         * Read the Transaction Date from a given TransactionMetaDataPair
         * object (gotten from NEM websockets or API).
         *
         * @param  [TransactionMetaDataPair]{@link http://bob.nem.ninja/docs/#transactionMetaDataPair} transactionMetaDataPair
         * @param  {boolean}    asNemTime   Whether to return a NEM Timestamp or UTC timestamp
         * @return {string}
         */
        this.getTransactionDate = function(transactionMetaDataPair, asNemTime = false) {
            var meta = transactionMetaDataPair.meta;
            var content = transactionMetaDataPair.transaction;

            var nemTime = content.timeStamp;
            var nemEpoch = Date.UTC(2015, 2, 29, 0, 6, 25, 0);

            if (asNemTime === true)
                return nemTime;

            return new Date(nemEpoch + (nemTime * 1000));
        };

        /**
         * Read the Transaction Amount.
         *
         * if `mosaicSlug` is provided and is different than
         * `nem:xem`, the transaction *must* be a mosaic transfer
         * transaction.
         *
         * @param   [TransactionMetaDataPair]{@link http://bob.nem.ninja/docs/#transactionMetaDataPair} transactionMetaDataPair
         * @param   {string}    mosaicSlug
         * @param   {integer}   divisibility
         * @return {[type]}                         [description]
         */
        this.getTransactionAmount = function(transactionMetaDataPair, mosaicSlug = 'nem:xem', divisibility = 6) {
            var meta = transactionMetaDataPair.meta;
            var content = transactionMetaDataPair.transaction;

            var isMultiSig = content.type === nem_.model.transactionTypes.multisigTransaction;
            var realContent = isMultiSig ? content.otherTrans : content;
            var isMosaic = realContent.mosaics && realContent.mosaics.length > 0;

            var lookupNS = mosaicSlug.replace(/:[^:]+$/, "");
            var lookupMos = mosaicSlug.replace(/^[^:]+:/, "");

            if (isMosaic) {
                // read mosaics to find XEM, `content.amount` is now a multiplier!

                var multiplier = realContent.amount / Math.pow(10, divisibility); // from microXEM to XEM
                for (var i in realContent.mosaics) {
                    var mosaic = realContent.mosaics[i];
                    var isLookupMosaic = mosaic.mosaicId.namespaceId == lookupNS 
                                       && mosaic.mosaicId.name == lookupMos;

                    if (!isLookupMosaic)
                        continue;

                    return (multiplier * mosaic.quantity).toFixed(divisibility);
                }

                // no XEM in transaction.
                return 0;
            }

            if (mosaicSlug !== 'nem:xem')
                return 0;

            // not a mosaic transer, `content.amount` is our XEM amount.
            return realContent.amount;
        };

        /**
         * This will read `slugToExtract` Mosaic amounts from the given Transaction
         * data `trxContent`.
         *
         * This method can be used to retrieve **one** Mosaic's total Amount in the
         * given Transaction Data using either the array in `trxContent.mosaics` or
         * the array in `trxContent.otherTrans.mosaics` in case of a multi signature
         * transaction.
         *
         * @param  {object} trxContent    - should be `TransactionMetaDataPair.transaction`
         * @param  {string} slugToExtract - Which mosaic ID to extract (i.e.: evias.pacnem:heart)
         * @return {object}
         */
        this.extractMosaicFromTransactionData_ = function(trxContent, slugToExtract, divisibility = 6) {
            if (!trxContent || !slugToExtract || !slugToExtract.length)
                return { totalMosaic: 0, recipient: false };

            if (trxContent.type == nem_.model.transactionTypes.multisigTransaction) {
                // multisig transaction mode
                // here we must check whether `trxContent.otherTrans.mosaics`
                // is set, this will use `res.data[i].transaction.otherTrans.mosaics`
                // from the raw Promise result.

                if (typeof trxContent.otherTrans == 'undefined')
                // MultiSig transactions WITHOUT `otherTrans` CANNOT contain Mosaics.
                    return false;

                if (typeof trxContent.otherTrans.mosaics == 'undefined')
                // No Mosaics in this one :()
                    return false;

                var trxMosaics = trxContent.otherTrans.mosaics;
                var recipient = trxContent.otherTrans.recipient;
                var trxAmount = trxContent.otherTrans.amount;
            }
            else {
                // transfer transaction mode
                // here we can simply read the `trxContent.mosaics`, this translates to
                // `res.data[i].transaction.mosaics` from the raw Promise result.

                if (typeof trxContent.mosaics == 'undefined' || !trxContent.mosaics.length)
                // we are interested only in Mosaic Transfer transactions
                    return false;

                var trxMosaics = trxContent.mosaics;
                var recipient = trxContent.recipient;
                var trxAmount = trxContent.amount;
            }

            // now iterate through the found mosaics and check whether
            // this transaction contains evias.pacnem:heart mosaics.
            for (j in trxMosaics) {
                var mosaic = trxMosaics[j];
                var slug = mosaic.mosaicId.namespaceId + ":" + mosaic.mosaicId.name;

                if (slugToExtract != slug)
                // mosaic filter
                    continue;

                // get the quantity, compute with transaction amount field in mosaic transfer
                // transaction, the amount field is in fact a QUANTITY. Whereas the `mosaic.quantity`
                // field represents the AMOUNT of Mosaics in the described Attachment.
                var mosAmount = parseInt(mosaic.quantity);

                // multiplier field stored in micro XEM in transactions!
                var mosMultiply = trxAmount > 0 ? parseInt(trxAmount / Math.pow(10, divisibility)) : 1;
                var totalMosaic = mosMultiply * mosAmount;

                // found our mosaic in `trxContent`
                return { totalMosaic: totalMosaic, recipient: recipient };
            }

            // didn't find our mosaic in `trxContent`
            return { totalMosaic: 0, recipient: false };
        };
    };

    module.exports.service = service;
}());