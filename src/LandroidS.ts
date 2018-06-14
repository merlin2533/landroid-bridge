import * as LandroidCloud from "iobroker.landroid-s/lib/landroid-cloud-2";
import { Config } from "./Config";
import { LandroidDataset } from "./LandroidDataset";
import { Mqtt } from "./Mqtt";
import { App } from "./App";

export class LandroidS {
    private static INSTANCE: LandroidS = new LandroidS();
    private static INIT_TIMEOUT: number = 60;
    private initialized: boolean = false;
    private landroidCloud: LandroidCloud;
    private latestUpdate: LandroidDataset;
    private firstCloudMessageCallback: Function = null;

    constructor() {
        if (LandroidS.INSTANCE) {
            throw new Error("Call LandroidS.getInstance() instead!");
        }
    }

    public getLatestUpdate(): LandroidDataset {
        return this.latestUpdate;
    }

    public startMower(): void {
        this.sendMessage(1);
    }

    public stopMower(): void {
        this.sendMessage(3);
    }

    public setTimeExtension(timeExtension: number): void {
        if (isNaN(timeExtension) || timeExtension < -100 || timeExtension > 100) {
            throw Error("Time extension must be >= -100 and <= 100");
        }
        timeExtension = Number(timeExtension);
        console.log("Setting time extension to %d", timeExtension);
        this.sendMessage(null, {sc: {p: timeExtension}});
    }

    public setRainDelay(rainDelay: number): void {
        if (isNaN(rainDelay) || rainDelay < 0 || rainDelay > 300) {
            throw Error("Rain delay must be >= 0 and <= 300");
        }
        rainDelay = Number(rainDelay);
        console.log("Setting rain delay to %d", rainDelay);
        this.sendMessage(null, {rd: rainDelay});
    }

    public setSchedule(weekday: number, val: string|Object): void {
        if (isNaN(weekday) || weekday < 0 || weekday > 6) {
            throw Error("Weekday must be >= 0 and <= 6 where 0 is Sunday");
        }
        if (!this.latestUpdate || !this.latestUpdate.schedule) {
            throw Error("Can only set new schedule when current schedule has been retrieved from cloud service");
        }
        let timePeriod = this.jsonToObject(val);
        if (!timePeriod) {
            throw Error("Value must be a valid JSON string or an object");
        }
        let message = this.latestUpdate.schedule.map(entry => this.timePeriodToCloudArray(entry.serialize()));
        message[weekday] = this.timePeriodToCloudArray(timePeriod);
        console.log("Setting new schedule with update for weekday %d to %s", weekday, JSON.stringify(message));
        this.sendMessage(null, {sc: {d: message}});
    }

    private timePeriodToCloudArray(timePeriod: any): Array<any> {
        return [
            ("00" + timePeriod["startHour"]).slice(-2) + ":" + ("00" + timePeriod["startMinute"]).slice(-2),
            parseInt(timePeriod["durationMinutes"], 10),
            (timePeriod["cutEdge"] ? 1 : 0)
        ];
    }

    private jsonToObject(json: string|Object) {
        if (typeof(json) === "string") {
            try {
                return JSON.parse(json);
            } catch (e) {
                return null;
            }
        } else {
            return json;
        }
    }

    public init(): Promise<void> {
        let adapter = {
            config: Config.getInstance().get("landroid-s"),
            log: {
                info: function(msg) { adapter.msg.info.push(msg);},
                error: function(msg) { adapter.msg.error.push(msg);},
                debug: function(msg) { adapter.msg.debug.push(msg);},
                warn: function(msg) { adapter.msg.warn.push(msg);}
            },
            msg: {
                info: [],
                error: [],
                debug: [],
                warn: []
            }
        };
        let doInit = function() {
            this.landroidCloud = new LandroidCloud(adapter);
            this.landroidCloud.init(this.updateListener.bind(this));
        };
        return new Promise((resolve, reject) => {
            if (this.initialized) {
                reject(new Error("Already initialized!"));
            }
            this.initialized = true;
            console.log("Initializing Landroid Cloud Service...");
            Mqtt.getInstance().on("mqttMessage", this.onMqttMessage.bind(this));
            let retryInterval;
            let onFirstCloudUpdate = function() {
                console.log("First cloud update received, finishing initialization");
                clearInterval(retryInterval);
                resolve();
            };
            let tryCount = 0;
            let retryInit = function() {
                tryCount++;
                if (tryCount > 1) {
                    console.log("Could not finish initialization, retrying...");
                    this.landroidCloud.updateListener = null;
                    delete this.landroidCloud;
                }
                this.firstCloudMessageCallback = onFirstCloudUpdate;
                doInit.bind(this)();
            };
            retryInterval = setInterval(retryInit.bind(this), LandroidS.INIT_TIMEOUT * 1000);
            retryInit.bind(this)();
        });
    }

    private sendMessage(cmd?: number, params?: Object): void {
        let message: Object = {};
        if (cmd) {
            message["cmd"] = cmd;
        }
        if (params) {
            message = Object.assign(message, params);
        }
        let outMsg = JSON.stringify(message);
        console.log("Sending to landroid cloud: %s", outMsg);
        this.landroidCloud.sendMessage(outMsg);
    }

    private updateListener(status: any): void {
        console.log("Incoming Landroid Cloud update: %s", JSON.stringify(status));
        let dataset: LandroidDataset = new LandroidDataset(status);
        this.publishMqtt(this.latestUpdate, dataset);
        this.latestUpdate = dataset;
        if (this.firstCloudMessageCallback) {
            this.firstCloudMessageCallback();
            this.firstCloudMessageCallback = null;
        }
    }

    private publishMqtt(previousDataset: LandroidDataset, currentDataset: LandroidDataset): void {
        let prev = (previousDataset ? previousDataset.serialize() : null);
        let curr = currentDataset.serialize();
        for (let key of Object.keys(curr)) {
            let val = curr[key];
            if (!prev || prev[key] !== val) {
                if (val instanceof Array) {
                    val.forEach((entry, i) => {
                        if (!prev || !prev[key] || !prev[key][i] || JSON.stringify(prev[key][i]) !== JSON.stringify(val[i])) {
                            Mqtt.getInstance().publish("status/" + key + "/" + i, JSON.stringify(val[i]), true);
                        }
                    });
                } else {
                    Mqtt.getInstance().publish("status/" + key, String(val), true);
                }
            }
        }
    }

    private onMqttMessage(topic: string, payload: any): void {
        try {
            if (topic === "set/start") {
                this.startMower();
            } else if (topic === "set/stop") {
                this.stopMower();
            } else if (topic === "set/mow") {
                if (payload === "start") {
                    this.startMower();
                } else if (payload === "stop") {
                    this.stopMower();
                } else {
                    console.error("Invalid MQTT payload for topic %s", topic);
                }
            } else if (topic === "set/rainDelay") {
                this.setRainDelay(payload);
            } else if (topic === "set/timeExtension") {
                this.setTimeExtension(payload);
            } else if (topic.startsWith("set/schedule/")) {
                let weekday = parseInt(topic.substr("set/schedule/".length), 10);
                this.setSchedule(weekday, String(payload));
            } else {
                console.error("Unknown MQTT topic: %s", topic);
            }
        } catch (e) {
            console.error("Invalid MQTT payload for topic %s: %s", topic, e);
        }
    }

    public static getInstance(): LandroidS {
        return LandroidS.INSTANCE;
    }
}
