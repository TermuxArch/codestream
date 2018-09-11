import { unique } from "underscore";
import { getStreamForId } from "../reducers/streams";
import { fetchPosts } from "../Stream/actions";
import { accessSafely } from "../utils";

export default store => next => action => {
	if (action.type === "ADD_STREAMS") {
		unique(action.payload, o => o.id).forEach(payload => {
			const { id, isTeamStream, teamId, memberIds } = payload;
			const { session, streams } = store.getState();

			if (isTeamStream || accessSafely(() => memberIds.includes(session.userId))) {
				const stream = getStreamForId(streams, id, teamId);
				if (!accessSafely(() => stream.memberIds.includes(session.userId))) {
					setImmediate(() => {
						store.dispatch(fetchPosts({ teamId, streamId: id }));
					});
				}
			}
		});
	}
	return next(action);
};
