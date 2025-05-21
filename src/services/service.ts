import { Indexer } from '../models/indexer';
import axios, { AxiosError, AxiosResponse } from 'axios';
import { arrayEquals, Entry, notEmpty } from '../helper';
import { JackettIndexer } from '../models/jackettIndexer';
import { ApiRoutes } from '../models/apiRoutes';
import { Services } from '../models/indexSpecificRule';
import { Config } from '../config';

export abstract class Service {
    abstract apiRoutes: ApiRoutes;
    serviceName: Services;
    categories: number[];
    seeds: number;
    indexers: Indexer[] = [];

    protected constructor(name: Services, categories: number[], seeds: number) {
        this.serviceName = name;
        this.categories = categories;
        this.seeds = seeds;
    }

    protected checkUrlAndApiKey(url: string | undefined, apiKey: string | undefined) {
        if (url === null || url === undefined || url === '') {
            throw new Error(`No url provided`);
        }

        if (apiKey === null || apiKey === undefined || apiKey === '') {
            throw new Error(`No apiKey provided`);
        }
    }

    async validate(): Promise<AxiosResponse> {
        return axios.get(this.apiRoutes.getSystemUrl());
    }

    async getIndexers(): Promise<void> {
        this.indexers = await this.handleIndexersRequest(this.apiRoutes.getIndexerUrl());
    };

    protected add(indexer: JackettIndexer) {
        const body = this.generateDefaultBody(indexer);
        return axios.post(this.apiRoutes.getIndexerUrl(), body);
    }

    protected update(appId: number | undefined, indexer: JackettIndexer): Promise<AxiosResponse> {
        const body = this.generateDefaultBody(indexer);
        body.id = appId;

        return axios.put(this.apiRoutes.getSpecificIndexerUrl(appId), body);
    }

    protected abstract mapToIndexer(entry: Entry): Indexer;

    protected abstract generateDefaultBody(indexer: JackettIndexer): Entry;

    async sync(jackettIndexers: JackettIndexer[]) {
        const { add, update } = this.checkDifferences(jackettIndexers);
        const addPromises = add.map(async (indexer) => {
            return this.handleRequest(this.add(indexer));
        });

        const updatePromises = update.map(async (indexer) => {
            const appId = this.indexers.find((existingIndexer) => existingIndexer.id === indexer.id)!.appId;
            return this.handleRequest(this.update(appId, indexer));
        });

        return await Promise.all(addPromises) && await Promise.all(updatePromises);
    }

    protected handleIndexersRequest(url: string): Promise<Indexer[]> {
        return axios.get(url)
            .then((response) => {
                return response.data.map((entry: Entry) => this.mapToIndexerWithCatch(entry));
            })
            .then((indexers) => {
                return indexers.filter((indexer: Indexer | undefined) => indexer && indexer.id !== undefined);
            })
            .catch((error) => {
                if (error && error.response) {
                    const axiosError = error as AxiosError;
                    console.error(`[${this.serviceName}][${axiosError.response?.status}] Couldn't get indexes, error: ${JSON.stringify(axiosError.response?.data)}, url: ${axiosError.config!.url}`);
                } else {
                    console.error(`[${this.serviceName}] Unexpected error during request`, error);
                }
                throw error;
            });
    }

    private mapToIndexerWithCatch(entry: Entry): Indexer | undefined {
        try {
            return this.mapToIndexer(entry);
        } catch (error) {
            console.warn(`[${this.serviceName}] Indexer ${entry.name} could not be parsed, skipping for check`);
        }
    }


    private handleRequest(axiosResponsePromise: Promise<AxiosResponse>) {
        return axiosResponsePromise.then((response) => {
            if (response.status == 201) {
                console.log(`[${this.serviceName}] Added ${response.data.name} successfully!`);
            } else if (response.status == 202) {
                console.log(`[${this.serviceName}] Updated ${response.data.name} successfully!`);
            } else {
                console.log(`[${this.serviceName}] Request successful, but unknown responseStatus`, response.data.name);
            }
        }).catch((error) => {
            if (error && error.response) {
                const axiosError = error as AxiosError;
                const data = JSON.parse(error.response.config.data);
                console.error(`[${this.serviceName}][${axiosError.response?.status}] Something went wrong with ${data.name}, error: ${(axiosError.response?.data as any)[0]?.errorMessage}`);
            } else {
                console.error(`[${this.serviceName}] Unexpected error during request`, error);
            }
        });
    }

    private checkDifferences(jackettIndexers: JackettIndexer[]): { add: JackettIndexer[], update: JackettIndexer[] } {
        const idList = jackettIndexers.map(el => el.id);
        const serviceIdList = this.indexers.map((indexer) => indexer.id).filter(notEmpty);

        const diff = idList.filter((id) => !serviceIdList.includes(id));
        const shouldBeAddedIndexers = diff.map((indexersId) => {
            const indexer = jackettIndexers.find((indexer) => indexer.id == indexersId)!;
            if (this.shouldAdd(indexer)) {
                return indexer;
            } {
                console.debug(`[${this.serviceName}] Skipping add for ${indexer.id}, since there were no matching categories.`)
            }
        }).filter(notEmpty);

        const same = idList.filter((id) => serviceIdList.includes(id));
        const shouldBeUpdatedIndexers = same.map((indexersId) => {
            const jacketIndexer = jackettIndexers.find((indexer) => indexer.id == indexersId)!;
            const existingIndexer = this.indexers.find((indexer) => indexer.id == indexersId)!;
            if (this.shouldUpdate(existingIndexer, jacketIndexer)) {
                return jacketIndexer;
            } else {
                console.debug(`[${this.serviceName}] Skipping update for ${existingIndexer.id}, since no updates were detected`)
            }
        }).filter(notEmpty);

        const notInJackett = serviceIdList.filter((id) => !idList.includes(id));
        notInJackett.forEach((indexer) => {
            console.warn(`[${this.serviceName}] Found indexer ${indexer} which is not in Jackett, please remove manually`)
        })

        return { add: shouldBeAddedIndexers, update: shouldBeUpdatedIndexers };
    }

    protected shouldAdd(indexer: JackettIndexer) {
        return indexer.categories.some(category => this.categories.includes(category)) || this.doesIndexerSpecificRuleApply(indexer);
    }

    protected shouldUpdate(current: Indexer, indexer: JackettIndexer) {
        return !current.compare(indexer) || !this.containsAllWantedCategories(current, indexer);
    }

    protected containsAllWantedCategories(current: Indexer, indexer: JackettIndexer): boolean {
        const availableCategories = this.categories.filter(id => indexer.categories.includes(id));

        this.undoIndexerSpecificConfiguration(indexer, current.categories, []);

        return arrayEquals(current.categories, availableCategories);
    }

    protected doesIndexerSpecificRuleApply(indexer: JackettIndexer): boolean {
        return -1 !== Config.indexSpecificRules.findIndex((indexSpecificRule) => {
            if (indexSpecificRule.service === Services.ALL || indexSpecificRule.service === this.serviceName) {
                if (indexer.id === indexSpecificRule.indexerId) {
                    return true;
                }
            }
            return false;
        });
    }

    protected indexerSpecificConfiguration(
        indexer: JackettIndexer,
        supportedCategories: number[],
        animeSupportedCategories: number[],
    ) {
        Config.indexSpecificRules.forEach((indexSpecificRule) => {
            if (indexSpecificRule.service === Services.ALL || indexSpecificRule.service === this.serviceName) {
                if (indexer.id === indexSpecificRule.indexerId) {
                    if (indexSpecificRule.category != null && !supportedCategories.includes(indexSpecificRule.category)) {
                        // console.log(`[${this.service}] Detected index specific setting, adding category ${indexSpecificRule.category}`);
                        supportedCategories.push(indexSpecificRule.category);
                    }
                    if (indexSpecificRule.animeCategory != null && !animeSupportedCategories.includes(indexSpecificRule.animeCategory)) {
                        // console.log(`[${this.service}] Detected index specific setting, adding animeCategory ${indexSpecificRule.animeCategory}`);
                        animeSupportedCategories.push(indexSpecificRule.animeCategory);
                    }
                }
            }
        });
    }

    protected undoIndexerSpecificConfiguration(
        indexer: JackettIndexer,
        supportedCategories: number[],
        animeSupportedCategories: number[],
    ) {
        Config.indexSpecificRules.forEach((indexSpecificRule) => {
            if (indexSpecificRule.service === Services.ALL || indexSpecificRule.service === this.serviceName) {
                if (indexer.id === indexSpecificRule.indexerId) {
                    if (indexSpecificRule.category != null && supportedCategories.includes(indexSpecificRule.category)) {
                        // console.log(`[${this.service}] Detected index specific setting, removing category ${indexSpecificRule.category}`);
                        supportedCategories.splice(supportedCategories.indexOf(indexSpecificRule.category), 1);
                    }
                    if (indexSpecificRule.animeCategory != null && animeSupportedCategories.includes(indexSpecificRule.animeCategory)) {
                        // console.log(`[${this.service}] Detected index specific setting, removing animeCategory ${indexSpecificRule.animeCategory}`);
                        animeSupportedCategories.splice(animeSupportedCategories.indexOf(indexSpecificRule.animeCategory), 1);
                    }
                }
            }
        });
    }
}