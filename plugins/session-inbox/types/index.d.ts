// What /inbox keeps between draws: the messages other sessions sent, and how the pane shows them.

// new: held, unread by the model; forwarded: the user sent it to the model; replied: the user answered it;
// passed: it went straight to the model (urgent, the mode was "pass", or a group's policy), kept here as a
// log line; sent: this session's own post to a group.
export type InboxStatus = 'new' | 'forwarded' | 'replied' | 'passed' | 'sent'

export type InboxMessage = {
  id: string
  at: number
  fromName: string
  // The sender's address as the envelope gives it (`uds:…`), what `$.session.send` takes; '' when absent.
  fromAddress: string
  origin: string
  body: string
  // The delivery as it arrived, envelope included: what a forward hands the model.
  raw: string
  urgent: boolean
  status: InboxStatus
  // The group the message was sent to (its `[group …]` tag), '' for a direct message. Absent on
  // messages kept from 0.1.
  group?: string
  // The group whose `pass` policy let it through, '' when none.
  via?: string
}

// A group the pane draws a section for, as the registry described it when last read.
export type GroupInfo = { id: string; kind: string; title: string }

declare module 'claude-code' {
  interface PluginState {
    'session-inbox': {
      messages: InboxMessage[]
      mode: 'hold' | 'pass'
      open: string
      replying: string
      // This session's name as ListAgents gives it, '' until first asked.
      selfName: string
      // The groups this session is in (every group while its name is unknown).
      groupInfo: GroupInfo[]
      // The pane's unfolded sections: group ids, and 'direct' for direct messages.
      expanded: string[]
      // When the model posted to a group, for its rate limit.
      groupSends: number[]
    }
  }
}
