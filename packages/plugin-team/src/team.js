/**!
 *
 * Copyright (c) 2015-2016 Cisco Systems, Inc. See LICENSE file.
 * @private
 */

import {find, pick, uniq} from 'lodash';
import {SparkPlugin} from '@ciscospark/spark-core';
import querystring from 'querystring';

const Team = SparkPlugin.extend({
  namespace: `Team`,

  /**
   * Move an existing group conversation into a team.
   * @param {TeamObject} team
   * @param {ConversationObject} conversation
   * @param {Object} activity Reference to the activity that will eventually be
   * posted. Use this to (a) pass in e.g. clientTempId and (b) render a
   * provisional activity
   * @returns {Promise} Resolves with the add activity
   */
  addConversation(team, conversation, activity) {
    return this._ensureGeneralConversation(team)
      .then((generalConversation) => this.spark.conversation.prepare(activity, {
        verb: `add`,
        target: this.spark.conversation.prepareConversation(generalConversation),
        object: {
          id: conversation.id,
          objectType: `conversation`
        },
        kmsMessage: {
          method: `create`,
          uri: `/authorizations`,
          resourceUri: conversation.kmsResourceObjectUrl,
          userIds: [generalConversation.kmsResourceObjectUrl]
        }
      }))
      .then((a) => this.spark.conversation.submit(a));
  },

  /**
   * Add a member to a team
   * @param {TeamObject} team
   * @param {Object} participant
   * @param {Object} activity Reference to the activity that will eventually be
   * posted. Use this to (a) pass in e.g. clientTempId and (b) render a
   * provisional activity
   * @returns {Promise} Resolves with activity that was posted
   */
  addMember(team, participant, activity) {
    return this._ensureGeneralConversation(team)
      .then((generalConversation) => this.spark.conversation.add(generalConversation, participant, activity));
  },

  /**
   * Create a team
   * @param {NewTeamObject} params
   * @param {string} params.displayName
   * @param {string} params.summary
   * @param {Array} params.participants
   * @returns {Promise} Resolves with the created team
   */
  create(params) {

    if (!params.displayName) {
      return Promise.reject(new Error(`\`params.displayName\` is required`));
    }

    if (!params.participants || params.participants.length === 0) {
      return Promise.reject(new Error(`\`params.participants\` is required`));
    }

    return Promise.all(params.participants.map((participant) => this.spark.user.asUUID(participant, {create: true})))
      .then((participants) => {
        participants.unshift(this.spark.device.userId);
        params.participants = uniq(participants);
      })
      .then(() => this._prepareTeam(params))
      .then((payload) => this.spark.request({
        method: `POST`,
        service: `conversation`,
        resource: `teams`,
        body: payload
      }))
      .then((res) => res.body);
  },

  /**
   * Create a conversation within a team. Currently does not support
   * activities besides add (ie no post or share activities).
   * @param {TeamObject} team
   * @param {NewConversationObject} params
   * @param {string} params.displayName
   * @param {string} params.summary
   * @param {Array} params.participants
   * @param {Object} options
   * @param {boolean} options.includeAllTeamMembers
   * @returns {Promise} Resolves with the newly created conversation
   */
  createConversation(team, params, options) {
    options = options || {};

    if (!params.displayName) {
      return Promise.reject(new Error(`\`params.displayName\` is required`));
    }

    return this._inferTeamUrl(team)
      .then(() => this._ensureGeneralConversation(team))
      .then((generalConversation) => Promise.all(
        params.participants.map((participant) => this.spark.user.asUUID(participant, {create: true}))
      )
        .then((participants) => {
          participants.unshift(this.spark.device.userId);
          params.participants = uniq(participants);
        })
        .then(() => this._prepareTeamConversation(generalConversation, params))
      )
      .then((payload) => this.spark.request({
        method: `POST`,
        uri: `${team.url}/conversations`,
        resource: `teams`,
        qs: pick(options, `includeAllTeamMembers`),
        body: payload
      }))
      .then((res) => res.body);
  },

  /**
   * Retrieve a single team
   * @param {Object|Team~TeamObject} team
   * @param {string} team.id
   * @param {Object} options
   * @param {boolean} options.includeTeamConversations
   * @param {boolean} options.includeTeamMembers
   * @returns {Promise} Resolves with the requested team
   */
  get(team, options) {
    options = options || {};

    const params = Object.assign({
      includeTeamConversations: false,
      includeTeamMembers: false
    }, options);

    return this._inferTeamUrl(team)
      .then(() => this.spark.request({
        uri: team.url,
        qs: params
      }))
      .then((res) => this._recordUUIDs(res.body)
        .then(() => res.body));
  },

  /**
   * Get the list of conversations for a particular team
   * @param {TeamObject} team
   * @returns {Promise} Resolves with an array of conversations
   */
  listConversations(team) {
    return this._inferTeamUrl(team)
      .then(() => this.spark.request({
        uri: `${team.url}/conversations`
      }))
      .then((res) => res.body.items);
  },

  /**
   * Join a team conversation
   * @param {TeamObject} team
   * @param {ConversationObject} conversation
   * @returns {Promise} Resolves with the conversation
   */
  joinConversation(team, conversation) {
    return this.spark.request({
      method: `POST`,
      uri: `${team.url}/conversations/${conversation.id}/participants`
    })
      .then((res) => res.body);
  },

  /**
   * Retrieve all teams
   * @param {Object} options
   * @param {boolean} options.includeTeamConversations
   * @param {boolean} options.includeTeamMembers
   * @returns {Promise} Resolves with the requested teams
   */
  list(options) {
    options = options || {};

    const params = Object.assign({
      includeTeamConversations: false,
      includeTeamMembers: false
    }, options);

    return this.spark.request({
      api: `conversation`,
      resource: `teams`,
      qs: params
    })
      .then((res) => Promise.all(res.body.items.map((team) => this._recordUUIDs(team)))
        .then(() => res.body.items));
  },

  /**
   * Remove a member from a team
   * @param {TeamObject} team
   * @param {Object} participant
   * @param {Object} activity Reference to the activity that will eventually be
   * posted. Use this to (a) pass in e.g. clientTempId and (b) render a
   * provisional activity
   * @returns {Promise} Resolves with activity that was posted
   */
  removeMember(team, participant, activity) {
    return this._ensureGeneralConversation(team)
      .then((generalConversation) => this.spark.conversation.leave(generalConversation, participant, activity));
  },

  /**
   * Remove a team conversation from a team.
   * @param {TeamObject} team
   * @param {ConversationObject} conversation to be removed
   * @param {Object} activity Reference to the activity that will eventually be
   * posted. Use this to (a) pass in e.g. clientTempId and (b) render a
   * provisional activity
   * @returns {Promise} Resolves with the leave activity
   */
  removeConversation(team, conversation, activity) {
    return this._ensureGeneralConversation(team)
      .then((generalConversation) => {
        const properties = {
          verb: `remove`,
          object: pick(conversation, `id`, `url`, `objectType`),
          target: pick(generalConversation, `id`, `url`, `objectType`),
          kmsMessage: {
            method: `delete`,
            uri: `<KRO>/authorizations?${querystring.stringify({authId: conversation.id})}`
          }
        };

        return this.spark.conversation.prepare(activity, properties);
      })
      .then((a) => this.spark.conversation.submit(a));
  },

  /**
   * Update the displayName, summary, or teamColor field for a team.
   * @param {TeamObject} team to be updated
   * @param {Object} object with updated displayName, summary, and/or teamColor
   * @param {Object} activity Reference to the activity that will eventually be
   * posted. Use this to (a) pass in e.g. clientTempId and (b) render a
   * provisional activity
   * @returns {Promise} Resolves with posted activity
   */
  update(team, object, activity) {
    return this.spark.conversation.update(team, object, activity);
  },

  _ensureGeneralConversation(team) {
    if (!team.generalConversationUuid) {
      return Promise.reject(new Error(`\`team.generalConversationUuid\` must be present`));
    }

    if (team.conversations.items.length) {
      const generalConversation = find(team.conversations.items, {id: team.generalConversationUuid});

      if (generalConversation) {
        return Promise.resolve(generalConversation);
      }
    }

    return this.spark.conversation.get({id: team.generalConversationUuid});
  },

  _inferTeamUrl(team) {
    if (!team.url && team.id) {
      return this.spark.device.getServiceUrl(`conversation`)
        .then((url) => {
          team.url = `${url}/teams/${team.id}`;
          /* istanbul ignore else */
          if (process.env.NODE_ENV !== `production`) {
            this.logger.warn(`team: inferred team url from conversation id; please pass whole team objects to Team methods`);
          }
          return team;
        });
    }

    return Promise.resolve(team);
  },

  _prepareTeam: function _prepareTeam(params) {
    const payload = this.spark.conversation._prepareConversationForCreation(params);

    payload.objectType = `team`;

    if (params.summary) {
      payload.summary = params.summary;
    }

    return Promise.resolve(payload);
  },

  _prepareTeamConversation(teamConversation, params) {
    if (!teamConversation.kmsResourceObjectUrl) {
      return Promise.reject(new Error(`Team general conversation must have a KRO`));
    }

    const payload = this.spark.conversation._prepareConversationForCreation(params);

    // Push the general conversation KRO on so that team members can
    // decrypt the title of this open room without joining it.
    payload.kmsMessage.userIds.push(teamConversation.kmsResourceObjectUrl);
    return Promise.resolve(payload);
  },

  _recordUUIDs(team) {
    if (!team.teamMembers || !team.teamMembers.items) {
      return Promise.resolve(team);
    }

    return Promise.all(team.teamMembers.items.map((participant) => this.spark.user.recordUUID(participant)));
  }

});

/**
 * Assign or unassign a team member to be a moderator of a team
 * @param {TeamObject} team
 * @param {Object} participant
 * @param {Object} activity
 * @returns {Promise} Resolves with activity that was posted
 */
[
  `assignModerator`,
  `unassignModerator`
].forEach((verb) => {
  Team.prototype[verb] = function submitModerationChangeActivity(team, member, activity) {
    return this._ensureGeneralConversation(team)
      .then((teamConversation) => this.spark.conversation[verb](teamConversation, member, activity));
  };
});

/**
 * Archive or unarchive a team or team conversation.
 * @param {TeamObject|ConversationObject} target team or team conversation that should be archived
 * @param {Object} activity Reference to the activity that will eventually be
 * posted. Use this to (a) pass in e.g. clientTempId and (b) render a
 * provisional activity
 * @returns {Promise} Resolves with the posted activity
 */
[
  `archive`,
  `unarchive`
].forEach((verb) => {
  Team.prototype[verb] = function submitArchiveStateChangeActivity(target, activity) {
    if (!target.objectType) {
      return Promise.reject(new Error(`\`target.objectType\` is required`));
    }

    const properties = {
      verb,
      object: pick(target, `id`, `url`, `objectType`),
      target: pick(target, `id`, `url`, `objectType`)
    };

    return this.spark.conversation.prepare(activity, properties)
      .then((a) => this.spark.conversation.submit(a));
  };
});

export default Team;
