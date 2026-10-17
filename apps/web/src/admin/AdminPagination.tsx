import { Alert, Button, Spinner } from "../ui/index.js";

export function AdminPagination({
  nextCursor,
  loadingMore,
  moreError,
  loadMore,
  count,
}: {
  nextCursor: string | undefined;
  loadingMore: boolean;
  moreError: boolean;
  loadMore: () => Promise<void>;
  count: number;
}) {
  return (
    <div className="admin-pagination">
      {moreError ? (
        <Alert tone="danger">
          后续数据加载失败，已加载的记录仍可查看。请重试。
        </Alert>
      ) : null}
      <div className="admin-pagination__footer">
        <span className="admin-dimmed" role="status">
          已加载 {count} 条{nextCursor ? "，还有更多记录" : "，已显示全部记录"}
        </span>
        {nextCursor ? (
          <Button
            variant="secondary"
            loading={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? <Spinner label="正在加载更多" size={16} /> : null}
            {moreError ? "重试加载" : "加载更多"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
