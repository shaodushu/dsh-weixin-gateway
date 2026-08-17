import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getUploadUrl } from "../api/api.js";
import { aesEcbPaddedSize } from "./aes-ecb.js";
import { uploadBufferToCdn } from "./cdn-upload.js";
import { logger } from "../util/logger.js";
import { redactUrl } from "../util/redact.js";
import { getExtensionFromContentTypeOrUrl } from "../media/mime.js";
import { tempFileName } from "../util/random.js";
import { UploadMediaType } from "../api/types.js";
/**
 * Download a remote media URL (image, video, file) to a local temp file in destDir.
 * Returns the local file path; extension is inferred from Content-Type / URL.
 */
export async function downloadRemoteImageToTemp(url, destDir) {
    logger.debug(`downloadRemoteImageToTemp: fetching url=${redactUrl(url)}`);
    let res;
    try {
        res = await fetch(url);
    }
    catch (err) {
        const cause = err.cause ?? err.code ?? "";
        logger.error(`downloadRemoteImageToTemp: fetch network error url=${redactUrl(url)} error=${String(err)}${cause ? ` cause=${cause}` : ""}`);
        throw err;
    }
    if (!res.ok) {
        const msg = `remote media download failed: ${res.status} ${res.statusText} url=${redactUrl(url)}`;
        logger.error(`downloadRemoteImageToTemp: ${msg}`);
        throw new Error(msg);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    logger.debug(`downloadRemoteImageToTemp: downloaded ${buf.length} bytes`);
    await fs.mkdir(destDir, { recursive: true });
    const ext = getExtensionFromContentTypeOrUrl(res.headers.get("content-type"), url);
    const name = tempFileName("weixin-remote", ext);
    const filePath = path.join(destDir, name);
    await fs.writeFile(filePath, buf);
    logger.debug(`downloadRemoteImageToTemp: saved to ${filePath} ext=${ext}`);
    return filePath;
}
/**
 * Common upload pipeline: read file → hash → gen aeskey → getUploadUrl → uploadBufferToCdn → return info.
 */
async function uploadMediaToCdn(params) {
    const { filePath, toUserId, opts, cdnBaseUrl, mediaType, label } = params;
    const plaintext = await fs.readFile(filePath);
    const rawsize = plaintext.length;
    const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = crypto.randomBytes(16).toString("hex");
    const aeskey = crypto.randomBytes(16);
    logger.debug(`${label}: file=${filePath} rawsize=${rawsize} filesize=${filesize} md5=${rawfilemd5} filekey=${filekey}`);
    const uploadUrlResp = await getUploadUrl({
        ...opts,
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize,
        rawfilemd5,
        filesize,
        no_need_thumb: true,
        aeskey: aeskey.toString("hex"),
    });
    const uploadFullUrl = uploadUrlResp.upload_full_url?.trim();
    const uploadParam = uploadUrlResp.upload_param;
    if (!uploadFullUrl && !uploadParam) {
        logger.error(`${label}: getUploadUrl returned no upload URL (need upload_full_url or upload_param), resp=${JSON.stringify(uploadUrlResp)}`);
        throw new Error(`${label}: getUploadUrl returned no upload URL`);
    }
    const { downloadParam: downloadEncryptedQueryParam } = await uploadBufferToCdn({
        buf: plaintext,
        uploadFullUrl: uploadFullUrl || undefined,
        uploadParam: uploadParam ?? undefined,
        filekey,
        cdnBaseUrl,
        aeskey,
        label: `${label}[orig filekey=${filekey}]`,
    });
    return {
        filekey,
        downloadEncryptedQueryParam,
        aeskey: aeskey.toString("hex"),
        fileSize: rawsize,
        fileSizeCiphertext: filesize,
    };
}
/** Upload a local image file to the Weixin CDN with AES-128-ECB encryption. */
export async function uploadFileToWeixin(params) {
    return uploadMediaToCdn({
        ...params,
        mediaType: UploadMediaType.IMAGE,
        label: "uploadFileToWeixin",
    });
}
/** Upload a local video file to the Weixin CDN. */
export async function uploadVideoToWeixin(params) {
    return uploadMediaToCdn({
        ...params,
        mediaType: UploadMediaType.VIDEO,
        label: "uploadVideoToWeixin",
    });
}
/**
 * Upload a local file attachment (non-image, non-video) to the Weixin CDN.
 * Uses media_type=FILE; no thumbnail required.
 */
export async function uploadFileAttachmentToWeixin(params) {
    return uploadMediaToCdn({
        ...params,
        mediaType: UploadMediaType.FILE,
        label: "uploadFileAttachmentToWeixin",
    });
}
/**
 * Upload a local SILK voice file to the Weixin CDN.
 * 实测：media_type=VOICE(4) 时 getUploadUrl 返回空（no upload URL），
 * 变通方案：用 FILE(3) 上传，CDN 引用挂到 voice_item 上。
 */
export async function uploadVoiceToWeixin(params) {
    return uploadMediaToCdn({
        ...params,
        mediaType: UploadMediaType.FILE,
        label: "uploadVoiceToWeixin",
    });
}
