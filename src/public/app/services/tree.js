import ws from './ws.js';
import utils from './utils.js';
import froca from './froca.js';
import hoistedNoteService from '../services/hoisted_note.js';
import appContext from "../components/app_context.js";

/**
 * @returns {string|null}
 */
async function resolveNotePath(notePath, hoistedNoteId = 'root') {
    const runPath = await resolveNotePathToSegments(notePath, hoistedNoteId);

    return runPath ? runPath.join("/") : null;
}

/**
 * Accepts notePath which might or might not be valid and returns an existing path as close to the original
 * notePath as possible. Part of the path might not be valid because of note moving (which causes
 * path change) or other corruption, in that case this will try to get some other valid path to the correct note.
 *
 * @returns {string[]}
 */
async function resolveNotePathToSegments(notePath, hoistedNoteId = 'root', logErrors = true) {
    utils.assertArguments(notePath);

    // we might get notePath with the params suffix, remove it if present
    notePath = notePath.split("?")[0].trim();

    if (notePath.length === 0) {
        return;
    }

    const path = notePath.split("/").reverse();

    if (!path.includes("root")) {
        path.push('root');
    }

    const effectivePathSegments = [];
    let childNoteId = null;
    let i = 0;

    while (true) {
        if (i >= path.length) {
            break;
        }

        const parentNoteId = path[i++];

        if (childNoteId !== null) {
            const child = await froca.getNote(childNoteId, !logErrors);

            if (!child) {
                if (logErrors) {
                    ws.logError(`Can't find note ${childNoteId}`);
                }

                return;
            }

            child.sortParents();

            const parents = child.getParentNotes();

            if (!parents.length) {
                if (logErrors) {
                    ws.logError(`No parents found for note ${childNoteId} (${child.title}) for path ${notePath}`);
                }

                return;
            }

            if (!parents.some(p => p.noteId === parentNoteId)) {
                if (logErrors) {
                    const parent = froca.getNoteFromCache(parentNoteId);

                    console.debug(utils.now(), `Did not find parent ${parentNoteId} (${parent ? parent.title : 'n/a'}) 
                        for child ${childNoteId} (${child.title}), available parents: ${parents.map(p => `${p.noteId} (${p.title})`)}. 
                        You can ignore this message as it is mostly harmless.`);
                }

                const bestNotePath = child.getBestNotePath(hoistedNoteId);

                if (bestNotePath) {
                    const pathToRoot = bestNotePath.reverse().slice(1);

                    for (const noteId of pathToRoot) {
                        effectivePathSegments.push(noteId);
                    }
                }

                break;
            }
        }

        effectivePathSegments.push(parentNoteId);
        childNoteId = parentNoteId;
    }

    effectivePathSegments.reverse();

    if (effectivePathSegments.includes(hoistedNoteId)) {
        return effectivePathSegments;
    }
    else {
        const note = await froca.getNote(getNoteIdFromNotePath(notePath));

        const bestNotePath = note.getBestNotePath(hoistedNoteId);

        if (!bestNotePath) {
            throw new Error(`Did not find any path segments for '${note.toString()}', hoisted note '${hoistedNoteId}'`);
        }

        // if there isn't actually any note path with hoisted note then return the original resolved note path
        return bestNotePath.includes(hoistedNoteId) ? bestNotePath : effectivePathSegments;
    }
}

ws.subscribeToMessages(message => {
   if (message.type === 'openNote') {
       appContext.tabManager.activateOrOpenNote(message.noteId);

       if (utils.isElectron()) {
           const currentWindow = utils.dynamicRequire('@electron/remote').getCurrentWindow();

           currentWindow.show();
       }
   }
});

function getParentProtectedStatus(node) {
    return hoistedNoteService.isHoistedNode(node) ? 0 : node.getParent().data.isProtected;
}

function getNoteIdFromNotePath(notePath) {
    if (!notePath) {
        return null;
    }

    const path = notePath.split("/");

    const lastSegment = path[path.length - 1];

    // path could have also params suffix
    return lastSegment.split("?")[0];
}

async function getBranchIdFromNotePath(notePath) {
    const {noteId, parentNoteId} = getNoteIdAndParentIdFromNotePath(notePath);

    return await froca.getBranchId(parentNoteId, noteId);
}

function getNoteIdAndParentIdFromNotePath(notePath) {
    if (notePath === 'root') {
        return {
            noteId: 'root',
            parentNoteId: 'none'
        };
    }

    let parentNoteId = 'root';
    let noteId = '';

    if (notePath) {
        const path = notePath.split("/");

        const lastSegment = path[path.length - 1];

        // path could have also params suffix
        noteId = lastSegment.split("?")[0];

        if (path.length > 1) {
            parentNoteId = path[path.length - 2];
        }
    }

    return {
        parentNoteId,
        noteId
    };
}

function getNotePath(node) {
    if (!node) {
        logError("Node is null");
        return "";
    }

    const path = [];

    while (node) {
        if (node.data.noteId) {
            path.push(node.data.noteId);
        }

        node = node.getParent();
    }

    return path.reverse().join("/");
}

async function getNoteTitle(noteId, parentNoteId = null) {
    utils.assertArguments(noteId);

    const note = await froca.getNote(noteId);
    if (!note) {
        return "[not found]";
    }

    let {title} = note;

    if (parentNoteId !== null) {
        const branchId = note.parentToBranch[parentNoteId];

        if (branchId) {
            const branch = froca.getBranch(branchId);

            if (branch && branch.prefix) {
                title = `${branch.prefix} - ${title}`;
            }
        }
    }

    return title;
}

async function getNotePathTitleComponents(notePath) {
    const titleComponents = [];

    if (notePath.startsWith('root/')) {
        notePath = notePath.substr(5);
    }

    // special case when we want just root's title
    if (notePath === 'root') {
        titleComponents.push(await getNoteTitle(notePath));
    } else {
        let parentNoteId = 'root';

        for (const noteId of notePath.split('/')) {
            titleComponents.push(await getNoteTitle(noteId, parentNoteId));

            parentNoteId = noteId;
        }
    }

    return titleComponents;
}

async function getNotePathTitle(notePath) {
    utils.assertArguments(notePath);

    const titlePath = await getNotePathTitleComponents(notePath);

    return titlePath.join(' / ');
}

async function getNoteTitleWithPathAsSuffix(notePath) {
    utils.assertArguments(notePath);

    const titleComponents = await getNotePathTitleComponents(notePath);

    if (!titleComponents || titleComponents.length === 0) {
        return "";
    }

    const title = titleComponents[titleComponents.length - 1];
    const path = titleComponents.slice(0, titleComponents.length - 1);

    const $titleWithPath = $('<span class="note-title-with-path">')
        .append($('<span class="note-title">').text(title));

    if (path.length > 0) {
        $titleWithPath
            .append($('<span class="note-path">').text(` (${path.join(' / ')})`));
    }

    return $titleWithPath;
}

function parseNavigationStateFromAddress() {
    const str = document.location.hash?.substr(1) || ""; // strip initial #

    const [notePath, paramString] = str.split("?");
    const viewScope = {
        viewMode: 'default'
    };
    let ntxId = null;
    let hoistedNoteId = null;

    if (paramString) {
        for (const pair of paramString.split("&")) {
            let [name, value] = pair.split("=");
            name = decodeURIComponent(name);
            value = decodeURIComponent(value);

            if (name === 'ntxId') {
                ntxId = value;
            } else if (name === 'hoistedNoteId') {
                hoistedNoteId = value;
            } else if (['viewMode', 'attachmentId'].includes(name)) {
                viewScope[name] = value;
            } else {
                console.warn(`Unrecognized hash parameter '${name}'.`);
            }
        }
    }

    return {
        notePath,
        ntxId,
        hoistedNoteId,
        viewScope
    };
}

function isNotePathInAddress() {
    const {notePath, ntxId} = parseNavigationStateFromAddress();

    return notePath.startsWith("root")
        // empty string is for empty/uninitialized tab
        || (notePath === '' && !!ntxId);
}

function isNotePathInHiddenSubtree(notePath) {
    return notePath?.includes("root/_hidden");
}

export default {
    resolveNotePath,
    resolveNotePathToSegments,
    getParentProtectedStatus,
    getNotePath,
    getNoteIdFromNotePath,
    getNoteIdAndParentIdFromNotePath,
    getBranchIdFromNotePath,
    getNoteTitle,
    getNotePathTitle,
    getNoteTitleWithPathAsSuffix,
    parseNavigationStateFromAddress,
    isNotePathInAddress,
    isNotePathInHiddenSubtree
};
