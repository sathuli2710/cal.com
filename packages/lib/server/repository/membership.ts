import { availabilityUserSelect, prisma, type PrismaTransaction, type PrismaClient } from "@calcom/prisma";
import { MembershipRole } from "@calcom/prisma/client";
import { Prisma } from "@calcom/prisma/client";
import { credentialForCalendarServiceSelect } from "@calcom/prisma/selects/credential";

import logger from "../../logger";
import { safeStringify } from "../../safeStringify";
import { eventTypeSelect } from "../eventTypeSelect";
import { LookupTarget, ProfileRepository } from "./profile";
import { withSelectedCalendars } from "./user";

const log = logger.getSubLogger({ prefix: ["repository/membership"] });
type IMembership = {
  teamId: number;
  userId: number;
  accepted: boolean;
  role: MembershipRole;
  createdAt?: Date;
};

const membershipSelect = Prisma.validator<Prisma.MembershipSelect>()({
  id: true,
  teamId: true,
  userId: true,
  accepted: true,
  role: true,
  disableImpersonation: true,
});

const teamParentSelect = Prisma.validator<Prisma.TeamSelect>()({
  id: true,
  name: true,
  slug: true,
  logoUrl: true,
  parentId: true,
  metadata: true,
});

const userSelect = Prisma.validator<Prisma.UserSelect>()({
  name: true,
  avatarUrl: true,
  username: true,
  id: true,
});

const getWhereForfindAllByUpId = async (upId: string, where?: Prisma.MembershipWhereInput) => {
  const lookupTarget = ProfileRepository.getLookupTarget(upId);
  let prismaWhere;
  if (lookupTarget.type === LookupTarget.Profile) {
    /**
     * TODO: When we add profileId to membership, we lookup by profileId
     * If the profile is movedFromUser, we lookup all memberships without profileId as well.
     */
    const profile = await ProfileRepository.findById(lookupTarget.id);
    if (!profile) {
      return [];
    }
    prismaWhere = {
      userId: profile.user.id,
      ...where,
    };
  } else {
    prismaWhere = {
      userId: lookupTarget.id,
      ...where,
    };
  }

  return prismaWhere;
};

export class MembershipRepository {
  constructor(private readonly prismaClient: PrismaClient = prisma) {}

  async hasMembership({ userId, teamId }: { userId: number; teamId: number }): Promise<boolean> {
    const membership = await this.prismaClient.membership.findFirst({
      where: {
        userId,
        teamId,
        accepted: true,
      },
      select: {
        id: true,
      },
    });
    return !!membership;
  }

  async listAcceptedTeamMemberIds({ teamId }: { teamId: number }): Promise<number[]> {
    const memberships =
      (await this.prismaClient.membership.findMany({
        where: {
          teamId,
          accepted: true,
        },
        select: {
          userId: true,
        },
      })) || [];
    const teamMemberIds = memberships.map((membership) => membership.userId);
    return teamMemberIds;
  }

  static async create(data: IMembership) {
    return await prisma.membership.create({
      data: {
        createdAt: new Date(),
        ...data,
      },
    });
  }

  static async createMany(data: IMembership[]) {
    return await prisma.membership.createMany({
      data: data.map((item) => ({
        createdAt: new Date(),
        ...item,
      })),
    });
  }

  /**
   * TODO: Using a specific function for specific tasks so that we don't have to focus on TS magic at the moment. May be try to make it a a generic findAllByProfileId with various options.
   */
  static async findAllByUpIdIncludeTeamWithMembersAndEventTypes(
    { upId }: { upId: string },
    { where }: { where?: Prisma.MembershipWhereInput } = {}
  ) {
    const prismaWhere = await getWhereForfindAllByUpId(upId, where);
    if (Array.isArray(prismaWhere)) {
      return prismaWhere;
    }

    log.debug(
      "findAllByUpIdIncludeTeamWithMembersAndEventTypes",
      safeStringify({
        prismaWhere,
      })
    );

    return await prisma.membership.findMany({
      where: prismaWhere,
      include: {
        team: {
          include: {
            members: {
              select: membershipSelect,
            },
            parent: {
              select: teamParentSelect,
            },
            eventTypes: {
              select: {
                ...eventTypeSelect,
                hashedLink: true,
                users: { select: userSelect },
                children: {
                  include: {
                    users: { select: userSelect },
                  },
                },
                hosts: {
                  include: {
                    user: { select: userSelect },
                  },
                },
              },
              // As required by getByViewHandler - Make it configurable
              orderBy: [
                {
                  position: "desc",
                },
                {
                  id: "asc",
                },
              ],
            },
          },
        },
      },
    });
  }

  static async findAllByUpIdIncludeMinimalEventTypes(
    { upId }: { upId: string },
    { where, skipEventTypes = false }: { where?: Prisma.MembershipWhereInput; skipEventTypes?: boolean } = {}
  ) {
    const prismaWhere = await getWhereForfindAllByUpId(upId, where);
    if (Array.isArray(prismaWhere)) {
      return prismaWhere;
    }

    log.debug(
      "findAllByUpIdIncludeMinimalEventTypes",
      safeStringify({
        prismaWhere,
      })
    );

    const select = Prisma.validator<Prisma.MembershipSelect>()({
      id: true,
      teamId: true,
      userId: true,
      accepted: true,
      role: true,
      disableImpersonation: true,
      team: {
        select: {
          ...teamParentSelect,
          isOrganization: true,
          parent: {
            select: teamParentSelect,
          },
          ...(!skipEventTypes
            ? {
                eventTypes: {
                  select: {
                    ...eventTypeSelect,
                    hashedLink: true,
                    children: { select: { id: true } },
                  },
                  orderBy: [
                    {
                      position: "desc",
                    },
                    {
                      id: "asc",
                    },
                  ],
                },
              }
            : {}),
        },
      },
    });

    return await prisma.membership.findMany({
      where: prismaWhere,
      select,
    });
  }

  static async findAllByUpIdIncludeTeam(
    { upId }: { upId: string },
    { where }: { where?: Prisma.MembershipWhereInput } = {}
  ) {
    const prismaWhere = await getWhereForfindAllByUpId(upId, where);
    if (Array.isArray(prismaWhere)) {
      return prismaWhere;
    }

    return await prisma.membership.findMany({
      where: prismaWhere,
      include: {
        team: {
          include: {
            parent: {
              select: teamParentSelect,
            },
          },
        },
      },
    });
  }

  static async findUniqueByUserIdAndTeamId({ userId, teamId }: { userId: number; teamId: number }) {
    return await prisma.membership.findUnique({
      where: {
        userId_teamId: {
          userId,
          teamId,
        },
      },
    });
  }

  static async findByTeamIdForAvailability({ teamId }: { teamId: number }) {
    const memberships = await prisma.membership.findMany({
      where: { teamId },
      include: {
        user: {
          select: {
            credentials: {
              select: credentialForCalendarServiceSelect,
            }, // needed for getUserAvailability
            ...availabilityUserSelect,
          },
        },
      },
    });

    const membershipsWithSelectedCalendars = memberships.map((m) => {
      return {
        ...m,
        user: withSelectedCalendars(m.user),
      };
    });

    return membershipsWithSelectedCalendars;
  }

  static async findMembershipsForBothOrgAndTeam({ orgId, teamId }: { orgId: number; teamId: number }) {
    const memberships = await prisma.membership.findMany({
      where: {
        teamId: {
          in: [orgId, teamId],
        },
      },
    });

    type Membership = (typeof memberships)[number];

    const { teamMemberships, orgMemberships } = memberships.reduce(
      (acc, membership) => {
        if (membership.teamId === teamId) {
          acc.teamMemberships.push(membership);
        } else if (membership.teamId === orgId) {
          acc.orgMemberships.push(membership);
        }
        return acc;
      },
      { teamMemberships: [] as Membership[], orgMemberships: [] as Membership[] }
    );

    return {
      teamMemberships,
      orgMemberships,
    };
  }

  static async getAdminOrOwnerMembership(userId: number, teamId: number) {
    return prisma.membership.findFirst({
      where: {
        userId,
        teamId,
        accepted: true,
        role: {
          in: [MembershipRole.ADMIN, MembershipRole.OWNER],
        },
      },
      select: {
        id: true,
      },
    });
  }
  static async findAllAcceptedMemberships(userId: number, tx?: PrismaTransaction) {
    return (tx ?? prisma).membership.findMany({
      where: {
        userId,
        accepted: true,
      },
      select: {
        teamId: true,
      },
    });
  }
  /**
   * Get all team IDs that a user is a member of
   */
  static async findUserTeamIds({ userId }: { userId: number }) {
    const memberships = await prisma.membership.findMany({
      where: {
        userId,
        accepted: true,
      },
      select: {
        teamId: true,
      },
    });

    return memberships.map((membership) => membership.teamId);
  }

  /**
   * Returns members who joined after the given time
   */
  static async findMembershipsCreatedAfterTimeIncludeUser({
    organizationId,
    time,
  }: {
    organizationId: number;
    time: Date;
  }) {
    return prisma.membership.findMany({
      where: {
        teamId: organizationId,
        createdAt: { gt: time },
        accepted: true,
      },
      include: {
        user: {
          select: {
            email: true,
            name: true,
            id: true,
          },
        },
      },
    });
  }

  static async findAllByTeamIds({
    teamIds,
    select = { userId: true },
  }: {
    teamIds: number[];
    select?: Prisma.MembershipSelect;
  }) {
    return prisma.membership.findMany({
      where: {
        team: {
          id: {
            in: teamIds,
          },
        },
        accepted: true,
      },
      select,
    });
  }
}
