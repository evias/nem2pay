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

    var config = require("config");
    var mongoose = require('mongoose');
    var increment = require("mongoose-increment");

    /**
     * class DBStore connects to a mongoDB database
     * either locally or using MONGODB_URI|MONGOLAB_URI env.
     *
     * This class also defines all available data
     * models.
     *
     * @author  Grégory Saive <greg@evias.be> (https://github.com/evias)
     */
    var DBStore = function(io, chainDataLayer) {
        var socket_ = io;
        var chainDataLayer_ = chainDataLayer;

        /**
         * Prepare the MongoDB database connection used
         * for session data storage and cached models.
         */
        host = process.env['MONGODB_URI'] || process.env['MONGOLAB_URI'] || "mongodb://localhost/NEM2Pay";
        mongoose.connect(host, function(err, res) {
            if (err)
                console.log("ERROR with NEM2Pay DB (" + host + "): " + err);
            else
                console.log("NEM2Pay Database connection is now up with " + host);
        });

        // Schema definition

        this.NEMPaymentChannel_ = new mongoose.Schema({
            payerXEM: String,
            recipientXEM: String,
            socketIds: [String],
            paymentMosaicSlug: String,
            amount: { type: Number, min: 0 },
            amountPaid: { type: Number, min: 0 },
            amountUnconfirmed: { type: Number, min: 0 },
            message: String,
            status: String,
            isPaid: { type: Boolean, default: false },
            paidAt: { type: Number, min: 0 },
            createdAt: { type: Number, min: 0 },
            updatedAt: { type: Number, min: 0 }
        });

        this.NEMPaymentChannel_.methods = {
            getPayer: function() {
                return this.payerXEM.toUpperCase().replace(/-/g, "");
            },
            getRecipient: function() {
                return this.recipientXEM.toUpperCase().replace(/-/g, "");
            },
            getQRData: function() {
                // data for QR code generation
                var invoiceData = {
                    "v": chainDataLayer_.getNetwork().isTest ? 1 : 2,
                    "type": 2,
                    "data": {
                        "addr": this.recipientXEM,
                        "amount": this.amount,
                        "msg": this.number,
                        "name": "NEM2Pay Invoice " + this.number
                    }
                };

                return invoiceData;
            },
            getTruncatedRecipient: function() {
                if (!this.recipientXEM || !this.recipientXEM.length)
                    return "";

                return this.recipientXEM.substr(0, 6) + "..." + this.recipientXEM.substr(-4);
            },
            getTotalIncoming: function() {
                return this.amountPaid + this.amountUnconfirmed;
            }
        };

        // configure invoice auto increment
        this.NEMPaymentChannel_.plugin(increment, {
            modelName: "NEMPaymentChannel",
            fieldName: "number",
            prefix: config.get("payments.invoicePrefix")
        });

        // bind our Models classes
        this.NEMPaymentChannel = mongoose.model("NEMPaymentChannel", this.NEMPaymentChannel_);
    };

    module.exports.DBStore = DBStore;
    module.exports.NEMPaymentChannel = pacnem.NEMPaymentChannel;
}());
