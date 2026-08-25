import time
from pathlib import Path
from typing import Any, cast

import click
import numpy as np
from sklearn.cluster import KMeans
from sklearn.preprocessing import normalize
from sqlalchemy.types import Boolean
from sqlmodel import func, select

from app.core.database import AsyncSessionLocal
from app.sync.model import Agent, Skill


def _active_agent_clause() -> Any:
    agent_payload = cast("Any", Agent.acs)
    return agent_payload["active"].astext.cast(Boolean)


class SkillClusteringSystem:
    """技能聚类系统 - 支持大规模数据的分批处理"""

    def __init__(self) -> None:
        """初始化聚类系统"""
        pass

    async def cluster_skills_in_batches(
        self,
        k: int = 10,
        batch_size: int = 10000,
        n_uniform: int = 5,
        top_m: int = 3,
        only_active: bool = True,
    ) -> dict[str, Any]:
        """
        分批读取技能进行聚类（核心方法）

        Args:
            k: 聚类簇数
            batch_size: 每批读取的技能数量
            n_uniform: 每个簇的均匀采样数量
            top_m: 每个簇的top-m采样数量
            only_active: 是否只处理active的智能体

        Returns:
            聚类结果字典
        """
        try:
            total_start = time.perf_counter()
            click.echo(f"\n{'=' * 60}")
            click.echo("🔍 开始分批聚类分析")
            click.echo(f"  - 聚类数: {k}")
            click.echo(f"  - 批次大小: {batch_size}")
            click.echo(f"  - 只处理active: {only_active}")
            click.echo(f"{'=' * 60}\n")

            # ============================================================
            # 阶段1: 统计总数
            # ============================================================
            t1 = time.perf_counter()
            async with AsyncSessionLocal() as session:
                count_stmt = select(func.count()).select_from(Skill).join(Agent)
                if only_active:
                    count_stmt = count_stmt.where(_active_agent_clause())

                total_count = int((await session.execute(count_stmt)).scalar_one())

            t2 = time.perf_counter()
            click.echo(f"📊 [阶段1] 统计完成: 共 {total_count:,} 个技能 (耗时: {(t2 - t1) * 1000:.2f}ms)")

            if total_count == 0:
                return {"success": False, "error": "没有找到技能数据", "total_skills": 0}

            # ============================================================
            # 阶段2: 分批读取 embeddings
            # ============================================================
            t3 = time.perf_counter()
            click.echo("\n📥 [阶段2] 开始分批读取 embeddings...")

            all_embeddings: list[list[float]] = []
            all_skill_info: list[dict[str, Any]] = []
            num_batches = (total_count - 1) // batch_size + 1

            for batch_idx in range(num_batches):
                offset = batch_idx * batch_size
                batch_start = time.perf_counter()

                async with AsyncSessionLocal() as session:
                    # 只读取必要字段：id, aic, skill_id, embedding, description
                    batch_stmt = select(Skill).join(Agent)
                    if only_active:
                        batch_stmt = batch_stmt.where(_active_agent_clause())

                    batch_stmt = batch_stmt.offset(offset).limit(batch_size)
                    query_result = await session.execute(batch_stmt)
                    batch_skills = query_result.scalars().all()

                # 提取数据
                for skill in batch_skills:
                    skill_id = skill.id
                    if skill_id is None:
                        raise RuntimeError("Skill row missing primary key")

                    all_embeddings.append(skill.embedding)
                    all_skill_info.append(
                        {
                            "id": skill_id,
                            "aic": skill.aic,
                            "skill_id": skill.skill_id,
                            "description": skill.description,
                        }
                    )

                batch_end = time.perf_counter()
                click.echo(
                    f"  批次 {batch_idx + 1}/{num_batches}: "
                    f"读取 {len(batch_skills)} 条 "
                    f"(offset={offset}, 耗时: {(batch_end - batch_start) * 1000:.2f}ms)"
                )

                # 释放内存
                del batch_skills

            t4 = time.perf_counter()

            # 转换为 numpy array
            embeddings = np.array(all_embeddings)
            embeddings_memory = embeddings.nbytes / 1024 / 1024

            click.echo("\n✅ [阶段2] 读取完成:")
            click.echo(f"  - 总技能数: {len(embeddings):,}")
            click.echo(f"  - Embedding维度: {embeddings.shape}")
            click.echo(f"  - 内存占用: {embeddings_memory:.2f} MB")
            click.echo(f"  - 总耗时: {(t4 - t3) * 1000:.2f}ms")

            # 释放原始列表
            del all_embeddings

            # ============================================================
            # 阶段3: 执行聚类
            # ============================================================
            t5 = time.perf_counter()
            click.echo(f"\n🧮 [阶段3] 开始聚类计算 (KMeans, k={k})...")

            embeddings_norm = normalize(embeddings, norm="l2")
            kmeans = KMeans(
                n_clusters=k,
                random_state=42,
                n_init=10,
                max_iter=300,
                verbose=0,
            )
            labels = kmeans.fit_predict(embeddings_norm)
            centers = kmeans.cluster_centers_
            centers_norm = normalize(centers, norm="l2")

            t6 = time.perf_counter()
            click.echo(f"✅ [阶段3] 聚类完成 (耗时: {(t6 - t5) * 1000:.2f}ms)")

            # ============================================================
            # 阶段4: 生成采样结果
            # ============================================================
            t7 = time.perf_counter()
            click.echo("\n📋 [阶段4] 生成采样结果...")

            cluster_samples_uniform: list[list[str]] = []
            cluster_samples_topm: list[list[str]] = []
            cluster_stats: list[dict[str, Any]] = []

            for cluster_id in range(k):
                # 找到属于该簇的所有索引
                idx = np.where(labels == cluster_id)[0]
                cluster_size = len(idx)

                if cluster_size == 0:
                    cluster_samples_uniform.append([])
                    cluster_samples_topm.append([])
                    cluster_stats.append(
                        {
                            "cluster_id": cluster_id,
                            "size": 0,
                            "skills": [],
                        }
                    )
                    continue

                # 计算该簇内所有点到簇中心的距离
                cluster_embeddings = embeddings_norm[idx]
                sims = cluster_embeddings @ centers_norm[cluster_id].T
                distances = 1 - sims

                # 按距离排序（从远到近）
                sorted_idx_local = np.argsort(distances)[::-1]
                sorted_idx_global = idx[sorted_idx_local]

                # 均匀采样
                n_points = len(sorted_idx_global)
                actual_n_uniform = min(n_uniform, n_points)
                sample_positions = np.linspace(0, n_points - 1, actual_n_uniform, dtype=int)
                sampled_indices_uniform = [sorted_idx_global[pos] for pos in sample_positions]

                # Top-M 采样（最接近簇中心的）
                actual_top_m = min(top_m, n_points)
                topm_local = np.argsort(distances)[:actual_top_m]
                topm_global = idx[topm_local]

                # 保存采样的描述
                uniform_descs = [all_skill_info[i]["description"] for i in sampled_indices_uniform]
                topm_descs = [all_skill_info[i]["description"] for i in topm_global]

                cluster_samples_uniform.append(uniform_descs)
                cluster_samples_topm.append(topm_descs)

                # 保存簇的统计信息（包含所有技能的ID）
                cluster_stats.append(
                    {
                        "cluster_id": cluster_id,
                        "size": cluster_size,
                        "skills": [
                            {
                                "id": all_skill_info[i]["id"],
                                "aic": all_skill_info[i]["aic"],
                                "skill_id": all_skill_info[i]["skill_id"],
                                "distance_to_center": float(distances[np.where(idx == i)[0][0]]),
                            }
                            for i in idx
                        ],
                    }
                )

            t8 = time.perf_counter()
            click.echo(f"✅ [阶段4] 采样完成 (耗时: {(t8 - t7) * 1000:.2f}ms)")

            # ============================================================
            # 阶段5: 构建结果
            # ============================================================
            cluster_result: dict[str, Any] = {
                "success": True,
                "config": {
                    "k": k,
                    "batch_size": batch_size,
                    "n_uniform": n_uniform,
                    "top_m": top_m,
                    "only_active": only_active,
                },
                "statistics": {
                    "total_skills": len(embeddings),
                    "num_clusters": k,
                    "embedding_dim": embeddings.shape[1],
                    "memory_mb": embeddings_memory,
                },
                "clusters": cluster_stats,
                "uniform_samples": cluster_samples_uniform,
                "topm_samples": cluster_samples_topm,
                "labels": labels.tolist(),
                "performance": {
                    "stage1_count_ms": (t2 - t1) * 1000,
                    "stage2_load_ms": (t4 - t3) * 1000,
                    "stage3_cluster_ms": (t6 - t5) * 1000,
                    "stage4_sample_ms": (t8 - t7) * 1000,
                    "total_ms": 0,
                },
            }

            total_end = time.perf_counter()
            cluster_result["performance"]["total_ms"] = (total_end - total_start) * 1000

            # ============================================================
            # 打印摘要
            # ============================================================
            click.echo(f"\n{'=' * 60}")
            click.echo("✅ 聚类完成！")
            click.echo(f"{'=' * 60}")
            click.echo("📊 统计信息:")
            click.echo(f"  - 总技能数: {len(embeddings):,}")
            click.echo(f"  - 聚类数: {k}")
            click.echo(f"  - 内存占用: {embeddings_memory:.2f} MB")
            click.echo("\n⏱️  性能指标:")
            click.echo(f"  - 统计耗时: {cluster_result['performance']['stage1_count_ms']:.2f}ms")
            click.echo(f"  - 读取耗时: {cluster_result['performance']['stage2_load_ms']:.2f}ms")
            click.echo(f"  - 聚类耗时: {cluster_result['performance']['stage3_cluster_ms']:.2f}ms")
            click.echo(f"  - 采样耗时: {cluster_result['performance']['stage4_sample_ms']:.2f}ms")
            click.echo(f"  - 总耗时: {cluster_result['performance']['total_ms']:.2f}ms")
            click.echo(f"{'=' * 60}\n")

            return cluster_result

        except Exception as exc:
            click.echo(f"\n❌ 聚类失败: {exc}", err=True)
            import traceback

            traceback.print_exc()

            return {
                "success": False,
                "error": str(exc),
                "traceback": traceback.format_exc(),
            }

    def print_cluster_summary(self, result: dict[str, Any]) -> None:
        """
        打印聚类结果摘要

        Args:
            result: 聚类结果字典
        """
        if not result["success"]:
            click.echo(f"❌ 聚类失败: {result.get('error')}", err=True)
            return

        k = result["config"]["k"]

        click.echo(f"\n{'=' * 80}")
        click.echo(f"聚类结果摘要 (k={k})")
        click.echo(f"{'=' * 80}\n")

        for i in range(k):
            cluster_info = result["clusters"][i]
            click.echo(f"簇 {i}:")
            click.echo(f"  大小: {cluster_info['size']} 个技能")

            click.echo("\n  均匀采样 (从远到近):")
            for j, desc in enumerate(result["uniform_samples"][i], 1):
                click.echo(f"    {j}. {desc[:80]}...")

            click.echo(f"\n  Top-{result['config']['top_m']} (最接近簇中心):")
            for j, desc in enumerate(result["topm_samples"][i], 1):
                click.echo(f"    {j}. {desc[:80]}...")

            click.echo(f"\n{'-' * 80}\n")


async def main() -> int:
    """主函数 - 演示如何使用"""

    # 1. 创建聚类系统实例
    clustering_system = SkillClusteringSystem()

    # 2. 执行聚类
    result = await clustering_system.cluster_skills_in_batches(
        k=10,  # 聚类数
        batch_size=10000,  # 每批读取10000个技能
        n_uniform=5,  # 每个簇均匀采样5个
        top_m=3,  # 每个簇取最接近中心的3个
        only_active=False,  # 只处理active的智能体
    )

    # 3. 打印结果摘要
    clustering_system.print_cluster_summary(result)
    save_path = Path(__file__).resolve().parents[1] / "prompts" / "cluster_prompt.txt"
    with save_path.open("w", encoding="utf-8") as f:
        for i, samples in enumerate(result["uniform_samples"]):
            f.write(f"=== 簇 {i} ===\n")
            for s in samples:
                f.write(f"- {s}\n")
            f.write("\n")

    return 0


if __name__ == "__main__":
    import asyncio

    raise SystemExit(asyncio.run(main()))
