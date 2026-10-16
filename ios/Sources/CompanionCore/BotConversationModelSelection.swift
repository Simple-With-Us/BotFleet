import Foundation

/// Which model selection a bot is answering with in one conversation thread.
/// Shared by the chat header, avatar badges, and message rows so a task
/// override cannot drift from the bot-wide active selection on another task.
public enum BotConversationModelSelection {
    public static func selection(for bot: Bot, inThread threadId: String) -> ModelSelection? {
        if let currentTask = bot.tasks?.first(where: { $0.threadId == threadId }) {
            if let taskSelection = currentTask.modelSelection {
                return currentTask.activeModelSelection ?? taskSelection
            }
            return currentTask.activeModelSelection ?? bot.modelSelection
        }
        return bot.activeModelSelection ?? bot.modelSelection
    }
}
