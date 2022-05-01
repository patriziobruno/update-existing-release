import * as core from '@actions/core';
import { getOctokitOptions, GitHub } from '@actions/github/lib/utils';
import { Context } from '@actions/github/lib/context';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { } from '@octokit/types';
import { config } from 'dotenv';
import { readFileSync, statSync, existsSync } from 'fs';
import { resolve, isAbsolute, basename } from 'path';
import { lookup } from 'mime-types';

const context = new Context();

class Tagger {
    public name: string;
    public email: string;
    public date: string;
    constructor() {
        this.name = 'update-existing-release github action';
        this.email = 'none'
        let now = new Date();
        this.date = now.toISOString();
    }
}

/**
 * A nexus for keeping track of, and managing the state of, the connection to Github.
 */
class Connection {
    /**
 * The Octokit Github object, used for most interactions with the server.
 */
    protected github: InstanceType<typeof GitHub>;
    /** 
     * The secret token used to authenticate with the server.
     */
    protected token: string = 'unknown-token'
    /**
     * The name of the owner whose repo we are building on.
     */
    protected owner: string = 'unknown-owner';
    /**
     * The name of the repo we are building on.
     */
    protected repo: string = 'unknown-repo';
    /**
     * The git ref that triggered this build.
     */
    protected ref: string = 'unknown-ref';
    /**
     * The friendly, autogenerated name of the release, derived from the git tag that triggered
     * this build.
     */
    protected release: string = 'unknown-release';

    /** 
     * The SHA associated with this build.
     */
    protected sha: string = 'unknown-sha';

    /** The tag for the release.  If it does not exist, it will be created.  If it does exist, 
     * it will be deleted and recreated.  If not given, it will be set to the same as the 
     * name of the release.
     */
    protected tag: string = 'unknown-tag';

    /**
     * The default single-line message for tags created by update-existing-release.
     */
    protected message: string = '';

    /**
     *  The default description body for any created release.
     */
    protected body: string = '';

    /** 
     * Is this a draft release?
     */
    protected draft: boolean = false;

    /**
     * Is this a prerelease?
     */
    protected prerelease: boolean = false;

    /**
     * The path to the file to be released.
     */
    protected files: Array<string> = [];

    /**
     * The Github context, useful for establishing the current user and project.
     */
    protected context: Object;

    constructor() {
        config();
        this.token = core.getInput('token', { required: true });
        core.setSecret(this.token);
        this.github = new GitHub(getOctokitOptions(
            this.token,
            {
                throttling,
                retry
            }
        ));
        this.context = context;
        [this.owner, this.repo] = process.env.GITHUB_REPOSITORY.split('/')
        this.ref = process.env.GITHUB_REF;
        this.sha = process.env.GITHUB_SHA;
        this.setRelease();
        this.setDraft();
        this.setPrerelease();
        this.setFiles();
        this.setMessage();
        this.setBody();
    }

    protected async createLightweightTag(tagger: Tagger) {
        return await this.github.rest.git.createTag({
            ...context.repo,
            tag: this.tag,
            message: this.message,
            object: this.sha,
            type: 'commit',
            tagger: tagger
        });
    }

    protected async createRelease() {
        try {
            core.startGroup('Creating release ' + this.release + '...')
            await this.github.rest.repos.createRelease(
                {
                    ...context.repo,
                    tag_name: this.tag,
                    name: this.release,
                    body: this.body,
                    draft: this.draft,
                    prerelease: this.prerelease
                }
            );

            core.endGroup();
        }
        catch (error) {
            this.fail(error);
        }
    }

    protected async updateRelease(id: number) {
        try {
            core.startGroup('Updating release ' + this.release + ' (' + id + ') ...')
            
            // Update release
            await this.github.rest.repos.updateRelease(
                {
                    ...context.repo,
                    release_id: id,
                    name: this.release,
                    body: this.body,
                    draft: this.draft,
                    prerelease: this.prerelease
                }
            );

            core.endGroup();
        }
        catch (error) {
            this.fail(error);
        }
    }

    protected async createTag() {
        try {
            let tagger = new Tagger();
            let tagObject = await this.createLightweightTag(tagger);
            await this.github.rest.git.createRef(
                {
                    ...context.repo,
                    ref: 'refs/tags/' + this.tag,
                    sha: tagObject.data.sha
                }
            )
        }
        catch (error) {
            this.fail(error);
        }
    }

    protected async deleteAssetsIfTheyExist(shouldDeleteAllExisting: boolean): Promise<boolean> {
        try {
            let assets = await this.getReleaseAssets();
            let result: boolean = false;

            for (let asset of assets) {
                let shouldDelete: boolean = shouldDeleteAllExisting;

                if(!shouldDeleteAllExisting){
                    for (let oneFile of this.files) {
                        if (asset.name === basename(oneFile)) {
                            shouldDelete = true;
                        }
                    }
                }

                if(shouldDelete){
                    core.startGroup('Deleting old release asset id ' + asset.id + '...');
                    await this.github.rest.repos.deleteReleaseAsset(
                        {
                            ...context.repo,
                            asset_id: asset.id
                        }
                    )
                    result = true;
                    core.endGroup();
                }
            }
            return result;
        }
        catch (error) {
            this.fail(error);
        }
    }

    protected async doesReleaseExist(): Promise<boolean> {
        try {
            let releases = await this.getReleases();
            return releases.includes(this.release);
        } catch (error) {
            this.fail(error);
        }
    }

    dump(name: string, thing: Object): void {
        console.debug(name + ':' + JSON.stringify(thing));
    }

    fail(error: Object): void {
        let formattedError = 'An error occurred while updating the release: \n' + JSON.stringify(error, null, 4);
        console.error(formattedError);
        core.setFailed(formattedError);
        console.trace();
        process.exit(2);
    }

    protected async getReleaseAssets() {
        try {
            core.startGroup('Getting assets for the release...')
            let id = await this.getReleaseID();
            console.debug('Release id: ' + id);
            if (id < 0)
                return;
            let assets = await this.github.rest.repos.listReleaseAssets({
                ...context.repo,
                release_id: id
            })
            this.dump('assets', assets.data);
            core.endGroup();
            return assets.data;
        }
        catch (error) {
            this.fail(error);
        }
    }

    protected async getReleaseID(): Promise<number> {
        try {
            core.startGroup('Finding ID of release...')

            let releasesObject = await this.github.rest.repos.listReleases({
                ...context.repo,
            });

            for (let release of releasesObject.data) {
                if(release.name == this.release) return release.id;
            }

            this.dump('releasesObjectData', releasesObject.data);
            core.endGroup();
        }
        catch (error) {
            this.fail(error);
        }

        this.fail('could not find id corresponding to release ' + this.release);
    }

    protected async getReleases(): Promise<Array<string>> {
        try {
            core.startGroup('Getting list of releases...')
            let releasesObject = await this.github.rest.repos.listReleases({
                ...context.repo,
            });
            let releases: Array<string> = [];
            for (let release of releasesObject.data) {
                releases.push(release.name);
            }
            this.dump('releases', releases);
            core.endGroup();
            return releases;
        }
        catch (error) {
            this.fail(error);
        }
    }

    protected async getReleaseUploadURL(): Promise<string> {
        let repos = await this.getRepos();
        for (let repo of repos) {
            if (repo.name === this.release) {
                return repo.upload_url;
            }
        }
        this.fail('could not find upload_url corresponding to release ' + this.release);
    }

    protected async getRepos() {
        try {
            core.startGroup('Getting list of repositories...')
            const allReleases = await this.github.rest.repos.listReleases({
                ...context.repo
            });
            const repos = allReleases.data;
            this.dump('repos', repos);
            core.endGroup();
            return repos;
        }
        catch (error) {
            this.fail(error);
        }
    }

    /**
     *  Returns details on the current tag, or false if it cannot be found.
     */
    protected async getTag() {
        try {
            core.startGroup('Getting list of repo tags...')
            let tagsQuery = await this.github.rest.repos.listTags(
                {
                    ...context.repo
                }
            );
            let tags = tagsQuery.data;
            core.endGroup();
            for (let tag of tags) {
                if (tag.name === this.tag) {
                    return tag;
                }
            }
            return false;
        } catch (error) {
            this.fail(error);
        }
    }

    public async run() {
        let tag = await this.getTag();

        // Create the tag if necessary
        if (tag === false) {
            await this.createTag();
            tag = await this.getTag();
        }

        if (!(await this.doesReleaseExist())) {
            await this.createRelease();
        }

        let id = await this.getReleaseID();
        console.debug('Release id: ' + id);

        if (id >= 0) {
            await this.updateRelease(id);
            await this.deleteAssetsIfTheyExist(isTruthyString(core.getInput('replace')));
            await this.uploadAssets(id);

            if(!isFalsyString(core.getInput('updateTag'))){
                await this.updateTag();
            }
        }
    }

    protected async setBody() {
        try {
            this.body = core.getInput('body');
            if (this.body !== '')
                return;
            const commitObject = await this.github.rest.git.getCommit({
                ...context.repo,
                commit_sha: this.sha
            });
            this.body = commitObject.data.message;
        }
        catch (error) {
            this.fail(error);
        }
    }

    protected setDraft() {
        this.draft = isTruthyString(core.getInput('draft'));
        core.setOutput('draft', this.draft ? 'true' : 'false');
    }

    protected setFiles() {
        let inputFileString: string = core.getInput('files', { required: true });
        let inputFiles: Array<string> = inputFileString.split(/[ ,\r\n\t]+/);
        for (let oneFile of inputFiles) {
            let tryPath: string = oneFile;
            if (!existsSync(tryPath) || !isAbsolute(tryPath)) {
                // go on a path hunt
                tryPath = resolve(process.env.GITHUB_WORKSPACE, oneFile);
                if (!existsSync(tryPath)) {
                    this.fail('could not find ' + oneFile +
                        ' as either absolute path or path relative to workspace');
                }
            }
            if (!existsSync(tryPath)) {
                this.fail('could not find file ' + tryPath +
                    ' for release; please provide a full path or path relative to workspace');
            }
            // Although Windows uses backslashes as separators, Windows can also use forward slashes as separators
            // and this choice is more compatible with cross-platform scripts
            this.files.push(tryPath.replace(/\\/g, '/'));
        }
        core.setOutput('files', JSON.stringify(this.files));
    }

    protected setMessage() {
        let message = core.getInput('message');
        if (message === '') {
            this.message = this.release + ' (automatically created)';
        }
    }

    protected setPrerelease() {
        this.prerelease = !isFalsyString(core.getInput('prerelease'));
        core.setOutput('prerelease', this.prerelease ? 'true' : 'false');
    }

    protected setRelease() {
        this.release = core.getInput('release');
        if (this.release === '') {
            this.release = this.ref;
            /* Convert a git ref to a friendlier looking name */
            this.release = this.release.replace(/refs\//, '');
            this.release = this.release.replace(/heads\//, '');
            this.release = this.release.replace(/tags\//, '');
            this.release = this.release.replace(/\//g, '-');
        }
        this.tag = core.getInput('tag');
        if (this.tag === '') {
            this.tag = this.release;
        }
        core.setOutput('release', this.release);
        core.setOutput('tag', this.tag);
    }

    protected async updateTag() {
        try {
            // Update tag
            console.debug('Updating tag ' + this.tag + ' to ' + this.sha);
            
            await this.github.rest.git.updateRef({
                ...context.repo,
                ref: `tags/${this.tag}`,
                sha: process.env.GITHUB_SHA
            });
        } catch (error) {
            this.fail(error);
        }
    }

    protected async uploadAssets(id: number) {
        try {
            // if we can't figure out what file type you have, we'll assign it this unknown type
            // https://www.iana.org/assignments/media-types/application/octet-stream
            const defaultAssetContentType = 'application/octet-stream';
            core.startGroup('Uploading release asset ' + this.files + '...')
            for (let oneFile of this.files) {

                let contentType: any = lookup(oneFile);
                if (contentType == false) {
                    console.warn('content type for file ' + oneFile +
                        ' could not be automatically determined from extension; going with ' +
                        defaultAssetContentType);
                    contentType = defaultAssetContentType;
                }

                // Determine content-length for header to upload asset
                const contentLength = statSync(oneFile).size;

                // Setup headers for API call, see Octokit Documentation: https://octokit.github.io/rest.js/#octokit-routes-repos-upload-release-asset for more information
                const headers = {
                    'content-type': contentType,
                    'content-length': contentLength
                };

                // Upload a release asset
                // API Documentation: https://developer.github.com/v3/repos/releases/#upload-a-release-asset
                // Octokit Documentation: https://octokit.github.io/rest.js/#octokit-routes-repos-upload-release-asset
                console.debug('Uploading release asset ' + oneFile);

                await this.github.rest.repos.uploadReleaseAsset({
                    ...context.repo,
                    release_id: id,
                    url: await this.getReleaseUploadURL(),
                    headers,
                    name: basename(oneFile),
                    data: readFileSync(oneFile).toString('binary')
                });
            }
            core.endGroup();
        } catch (error) {
            this.fail(error);
        }
    }
}

function isTruthyString(string: String){
    return string === 'true' || string == 'yes';
}

function isFalsyString(string: String){
    return string === 'false' || string == 'no';
}

core.startGroup('Updating release...');
let connection = new Connection();
connection.run();
core.endGroup();
