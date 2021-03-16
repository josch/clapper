const { Gio, GLib, GObject, Gst, Soup } = imports.gi;
const ByteArray = imports.byteArray;
const Debug = imports.src.debug;
const Misc = imports.src.misc;
const YTDL = imports.src.assets['node-ytdl-core'];

const { debug } = Debug;

var YouTubeClient = GObject.registerClass({
    Signals: {
        'info-resolved': {
            param_types: [GObject.TYPE_BOOLEAN]
        }
    }
}, class ClapperYouTubeClient extends Soup.Session
{
    _init()
    {
        super._init({
            timeout: 5,
        });

        /* videoID of current active download */
        this.downloadingVideoId = null;

        this.lastInfo = null;
        this.cachedSig = {
            id: null,
            actions: null,
        };
    }

    getVideoInfoPromise(videoId)
    {
        /* If in middle of download and same videoID,
         * resolve to current download */
        if(
            this.downloadingVideoId
            && this.downloadingVideoId === videoId
        )
            return this._getCurrentDownloadPromise();

        return new Promise(async (resolve, reject) => {
            /* Do not redownload info for the same video */
            if(this.compareLastVideoId(videoId))
                return resolve(this.lastInfo);

            this.abort();

            let tries = 2;
            while(tries--) {
                debug(`obtaining YouTube video info: ${videoId}`);
                this.downloadingVideoId = videoId;

                let result = await this._getInfoPromise(videoId).catch(debug);

                if(!result || !result.data) {
                    if(result && result.isAborted)
                        return reject(new Error('download aborted'));

                    debug(`failed, remaining tries: ${tries}`);
                    continue;
                }
                const info = result.data;

                const invalidInfoMsg = (
                    !info.playabilityStatus
                    || !info.playabilityStatus.status === 'OK'
                )
                    ? 'video is not playable'
                    : (!info.streamingData)
                    ? 'video response data is missing streaming data'
                    : null;

                if(invalidInfoMsg) {
                    this.lastInfo = null;

                    debug(new Error(invalidInfoMsg));
                    break;
                }

                /* Make sure we have all formats arrays,
                 * so we will not have to keep checking */
                if(!info.streamingData.formats)
                    info.streamingData.formats = [];
                if(!info.streamingData.adaptiveFormats)
                    info.streamingData.adaptiveFormats = [];

                if(this._getIsCipher(info.streamingData)) {
                    debug('video requires deciphering');

                    /* Decipher actions do not change too often, so try
                     * to reuse without triggering too many requests ban */
                    let actions = this.cachedSig.actions;

                    if(actions)
                        debug('using remembered decipher actions');
                    else {
                        const embedUri = `https://www.youtube.com/embed/${videoId}`;
                        result = await this._downloadDataPromise(embedUri).catch(debug);

                        if(result && result.isAborted)
                            break;
                        else if(!result || !result.data) {
                            debug(new Error('could not download embed body'));
                            continue;
                        }

                        const ytPath = result.data.match(/(?<=jsUrl\":\").*?(?=\")/gs)[0];
                        if(!ytPath) {
                            debug(new Error('could not find YouTube player URI'));
                            break;
                        }
                        const ytUri = `https://www.youtube.com${ytPath}`;
                        if(
                            /* check if site has "/" after ".com" */
                            ytUri[23] !== '/'
                            || !Gst.Uri.is_valid(ytUri)
                        ) {
                            debug(`misformed player URI: ${ytUri}`);
                            break;
                        }
                        debug(`found player URI: ${ytUri}`);

                        const ytId = ytPath.split('/').find(el => Misc.isHex(el));
                        actions = await this._getCacheFileActionsPromise(ytId).catch(debug);

                        if(!actions) {
                            result = await this._downloadDataPromise(ytUri).catch(debug);

                            if(result && result.isAborted)
                                break;
                            else if(!result || !result.data) {
                                debug(new Error('could not download player body'));
                                continue;
                            }

                            actions = YTDL.sig.extractActions(pBody);
                            if(actions) {
                                debug('deciphered');
                                this._createCacheFileAsync(ytId, actions);
                            }
                        }
                        if(!actions || !actions.length) {
                            debug(new Error('could not extract decipher actions'));
                            break;
                        }
                        if(this.cachedSig.id !== ytId) {
                            this.cachedSig.id = ytId;
                            this.cachedSig.actions = actions;
                        }
                    }
                    debug(`successfully obtained decipher actions: ${actions}`);

                    const isDeciphered = this._decipherStreamingData(
                        info.streamingData, actions
                    );
                    if(!isDeciphered) {
                        debug('streaming data could not be deciphered');
                        break;
                    }
                }

                this.lastInfo = info;
                this.emit('info-resolved', true);
                this.downloadingVideoId = null;

                return resolve(info);
            }

            /* Do not clear video info here, as we might still have
             * valid info from last video that can be reused */
            this.emit('info-resolved', false);
            this.downloadingVideoId = null;

            reject(new Error('could not obtain YouTube video info'));
        });
    }

    getBestCombinedUri(info)
    {
        if(!info.streamingData.formats.length)
            return null;

        const combinedStream = info.streamingData.formats[
            info.streamingData.formats.length - 1
        ];

        if(!combinedStream || !combinedStream.url)
            return null;

        return combinedStream.url;
    }

    compareLastVideoId(videoId)
    {
        if(!this.lastInfo)
            return false;

        if(
            !this.lastInfo
            || !this.lastInfo.videoDetails
            || this.lastInfo.videoDetails.videoId !== videoId
            /* TODO: check if video expired */
        )
            return false;

        return true;
    }

    _downloadDataPromise(url)
    {
        return new Promise((resolve, reject) => {
            const message = Soup.Message.new('GET', url);
            const result = {
                data: '',
                isAborted: false,
            };

            const chunkSignal = message.connect('got-chunk', (msg, chunk) => {
                debug(`got chunk of data, length: ${chunk.length}`);

                const chunkData = chunk.get_data();
                if(!chunkData) return;

                result.data += (chunkData instanceof Uint8Array)
                    ? ByteArray.toString(chunkData)
                    : chunkData;
            });

            this.queue_message(message, (session, msg) => {
                msg.disconnect(chunkSignal);

                debug('got message response');
                const statusCode = msg.status_code;

                if(statusCode === 200)
                    return resolve(result);

                debug(new Error(`response code: ${statusCode}`));

                /* Internal Soup codes mean download aborted
                 * or some other error that cannot be handled
                 * and we do not want to retry in such case */
                if(statusCode < 10 || statusCode === 429) {
                    result.isAborted = true;
                    return resolve(result);
                }

                return reject(new Error('could not download data'));
            });
        });
    }

    _getCurrentDownloadPromise()
    {
        debug('resolving after current download finishes');

        return new Promise((resolve, reject) => {
            const infoResolvedSignal = this.connect('info-resolved', (self, success) => {
                this.disconnect(infoResolvedSignal);

                debug('current download finished, resolving');

                if(!success)
                    return reject(new Error('info resolve was unsuccessful'));

                /* At this point new video info is set */
                resolve(this.lastInfo);
            });
        });
    }

    _getInfoPromise(videoId)
    {
        return new Promise((resolve, reject) => {
            const query = [
                `video_id=${videoId}`,
                `el=embedded`,
                `eurl=https://youtube.googleapis.com/v/${videoId}`,
            ].join('&');
            const url = `https://www.youtube.com/get_video_info?${query}`;

            this._downloadDataPromise(url).then(result => {
                if(result.isAborted)
                    return resolve(result);

                debug('parsing video info JSON');

                const gstUri = Gst.Uri.from_string('?' + result.data);

                if(!gstUri)
                    return reject(new Error('could not convert query to URI'));

                const playerResponse = gstUri.get_query_value('player_response');

                if(!playerResponse)
                    return reject(new Error('no player response in query'));

                let info = null;

                try { info = JSON.parse(playerResponse); }
                catch(err) { debug(err.message) }

                if(!info)
                    return reject(new Error('could not parse video info JSON'));

                debug('successfully parsed video info JSON');
                result.data = info;

                resolve(result);
            })
            .catch(err => reject(err));
        });
    }

    _getIsCipher(data)
    {
        /* Check only first best combined,
         * AFAIK there are no videos without it */
        if(data.formats[0].url)
            return false;

        if(
            data.formats[0].signatureCipher
            || data.formats[0].cipher
        )
            return true;

        /* FIXME: no URLs and no cipher, what now? */
        debug(new Error('no url or cipher in streams'));

        return false;
    }

    _decipherStreamingData(data, actions)
    {
        debug('checking cipher query keys');

        /* Cipher query keys should be the same for all
         * streams, so parse any stream to get their names */
        const anyStream = data.formats[0] || data.adaptiveFormats[0];
        const sigQuery = anyStream.signatureCipher || anyStream.cipher;

        if(!sigQuery)
            return false;

        const gstUri = Gst.Uri.from_string('?' + sigQuery);
        const queryKeys = gstUri.get_query_keys();

        const cipherKey = queryKeys.find(key => {
            const value = gstUri.get_query_value(key);
            /* A long value that is not URI */
            return (
                value.length > 32
                && !Gst.Uri.is_valid(value)
            );
        });
        if(!cipherKey) {
            debug('no stream cipher key name');
            return false;
        }

        const sigKey = queryKeys.find(key => {
            const value = gstUri.get_query_value(key);
            /* A short value that is not URI */
            return (
                value.length < 32
                && !Gst.Uri.is_valid(value)
            );
        });
        if(!sigKey) {
            debug('no stream signature key name');
            return false;
        }

        const urlKey = queryKeys.find(key =>
            Gst.Uri.is_valid(gstUri.get_query_value(key))
        );
        if(!urlKey) {
            debug('no stream URL key name');
            return false;
        }

        const cipherKeys = {
            url: urlKey,
            sig: sigKey,
            cipher: cipherKey,
        };

        debug('deciphering streams');

        for(let format of [data.formats, data.adaptiveFormats]) {
            for(let stream of format) {
                const formatUrl = this._getDecipheredUrl(
                    stream, actions, cipherKeys
                );
                if(!formatUrl) {
                    debug('undecipherable stream');
                    debug(stream);

                    return false;
                }
                stream.url = formatUrl;
            }
        }
        debug('all streams deciphered');

        return true;
    }

    _getDecipheredUrl(stream, actions, queryKeys)
    {
        debug(`deciphering stream id: ${stream.itag}`);

        const sigQuery = stream.signatureCipher || stream.cipher;
        if(!sigQuery) return null;

        const gstUri = Gst.Uri.from_string('?' + sigQuery);

        const url = gstUri.get_query_value(queryKeys.url);
        const cipher = gstUri.get_query_value(queryKeys.cipher);
        const sig = gstUri.get_query_value(queryKeys.sig);

        const key = YTDL.sig.decipher(cipher, actions);
        if(!key) return null;

        debug('stream deciphered');

        return `${url}&${sig}=${key}`;
    }

    async _createCacheFileAsync(ytId, actions)
    {
        debug('saving cipher actions to cache file');

        const ytCacheDir = Gio.File.new_for_path([
            GLib.get_user_cache_dir(),
            Misc.appId,
            'yt-sig'
        ].join('/'));

        for(let dir of [ytCacheDir.get_parent(), ytCacheDir]) {
            if(dir.query_exists(null))
                continue;

            const dirCreated = await dir.make_directory_async(
                GLib.PRIORITY_DEFAULT,
                null,
            ).catch(debug);

            if(!dirCreated) {
                debug(new Error(`could not create dir: ${dir.get_path()}`));
                return;
            }
        }

        const cacheFile = ytCacheDir.get_child(ytId);
        cacheFile.replace_contents_bytes_async(
            GLib.Bytes.new_take(actions),
            null,
            false,
            Gio.FileCreateFlags.NONE,
            null
        )
        .then(() => debug('saved cache file'))
        .catch(debug);
    }

    _getCacheFileActionsPromise(ytId)
    {
        return new Promise((resolve, reject) => {
            debug('checking decipher actions from cache file');

            const ytActionsFile = Gio.File.new_for_path([
                GLib.get_user_cache_dir(),
                Misc.appId,
                'yt-sig',
                ytId
            ].join('/'));

            if(!ytActionsFile.query_exists(null)) {
                debug(`no such cache file: ${ytId}`);
                return resolve(null);
            }

            ytActionsFile.load_bytes_async(null)
                .then(result => {
                    const data = result[0].get_data();
                    if(!data || !data.length)
                        return reject(new Error('actions cache file is empty'));

                    if(data instanceof Uint8Array)
                        resolve(ByteArray.toString(data));
                    else
                        resolve(data);
                })
                .catch(err => reject(err));
        });
    }
});

function checkYouTubeUri(uri)
{
    const gstUri = Gst.Uri.from_string(uri);
    const originalHost = gstUri.get_host();
    gstUri.normalize();

    const host = gstUri.get_host();
    let videoId = null;

    switch(host) {
        case 'www.youtube.com':
        case 'youtube.com':
            videoId = gstUri.get_query_value('v');
            if(!videoId) {
                /* Handle embedded videos */
                const segments = gstUri.get_path_segments();
                if(segments && segments.length)
                    videoId = segments[segments.length - 1];
            }
            break;
        case 'youtu.be':
            videoId = gstUri.get_path_segments()[1];
            break;
        default:
            const scheme = gstUri.get_scheme();
            if(scheme === 'yt' || scheme === 'youtube') {
                /* ID is case sensitive */
                videoId = originalHost;
                break;
            }
            break;
    }

    const success = (videoId != null);

    return [success, videoId];
}
