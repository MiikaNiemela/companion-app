/**
 * Represents a unit of multimodal chat: text, video, audio, or image.
 *
 * For streaming responses, just update the `text` argument.
 */
export function ChatBlock({text, mimeType, url} : {
    text?: string,
    mimeType?: string,
    url?: string
}) {
    let internalComponent = <></>
    if (text) {
        internalComponent = <span>{text}</span>
    } else if (mimeType && url) {
        if (mimeType.startsWith("audio")) {
            internalComponent = <audio controls={true} src={url} />
        } else if (mimeType.startsWith("video")) {
            internalComponent = <video controls width="250">
                <source src={url} type={mimeType} />
                Download the <a href={url}>video</a>
            </video>
        } else if (mimeType.startsWith("image")) {
            internalComponent = <img src={url} alt="" />
        }
    } else if (url) {
        internalComponent = <a href={url}>Link</a>
    }

    return (
        <div className="break-words text-sm text-inherit [&:not(:last-child)]:pb-2">
            {internalComponent}
        </div>
    );
}

/**
 * Take a completion, which may be a string, JSON encoded as a string, or JSON object,
 * and produce a list of ChatBlock objects. This is intended to be a one-size-fits-all
 * method for funneling different LLM output into structure that supports different media
 * types and can easily grow to support more metadata (such as speaker).
 */
/** Serializable data accepted by the multimodal leaf renderer. */
export type ChatBlockData = {
    text?: string,
    mimeType?: string,
    url?: string
}

export function responseToChatBlocks(completion: any): ChatBlockData[] {
    // First we try to parse completion as JSON in case we're dealing with an object.
    if (typeof completion == "string") {
        try {
            completion = JSON.parse(completion)
        } catch {
            // Do nothing; we'll just treat it as a string.
        }
    }
    let blocks = []
    if (typeof completion == "string") {
        blocks.push({ text: completion })
    } else if (Array.isArray(completion)) {
        for (let block of completion) {
            blocks.push(block)
        }
    } else {
        blocks.push(completion)
    }
    return blocks
}

