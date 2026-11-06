/**
 * instruction_channel — where a pack's instruction block is delivered: the MCP
 * `initialize` instructions (`server`), the generated in-project guide (`guide`)
 * or a live agent brief (`brief`). A block naming none reaches the server only,
 * where every block went before channels existed.
 */
export const INSTRUCTION_CHANNELS = ['server', 'guide', 'brief'] as const;
export type InstructionChannel = (typeof INSTRUCTION_CHANNELS)[number];

/**
 * loaded_instruction_block.reaches — whether a block is delivered to a channel
 * under a governing profile: the channel must be one it names (none named =
 * server only), and a profile-scoped block applies only when it names the
 * profile. A block scoped to a profile that cannot be resolved is withheld, so
 * a pack that says "only under my profile" never leaks its platform doctrine
 * elsewhere. Pure.
 */
export function blockReaches(
  block: { channels?: InstructionChannel[]; profile?: string[] },
  channel: InstructionChannel,
  profile: string | null,
): boolean {
  const channels = block.channels ?? ['server'];
  if (!channels.includes(channel)) return false;
  if (!block.profile || block.profile.length === 0) return true;
  return profile !== null && block.profile.includes(profile);
}
