-- Delay visibility of bridge-rejected question rejections until `available_at`
-- so that `ask`'s unread footer, `check_inbox`, and `GET /unread` align with
-- the delayed webhook wake (docs/design.md 3.4, #18).
-- NULL means immediately visible (questions, answers, recipient declines, and
-- expired-question rejections).
ALTER TABLE messages ADD COLUMN available_at INTEGER;
